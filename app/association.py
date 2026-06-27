"""
Person–object association for the littering pipeline.

Call Associator.update(frame_idx, detections) once per frame with the output of
detect_and_track().  Query per-object state via .object_states[track_id].

Ownership rules
---------------
- An object whose center sits inside a person bbox for CARRY_FRAMES consecutive
  frames gets that person as its confirmed owner.
- Hysteresis: once owned, ownership survives HYSTERESIS_FRAMES frames of
  non-overlap before being officially dropped.  This tolerates brief occlusion and
  box jitter without false separations.
- On separation (hysteresis exhausted): dropped_at and drop_location are recorded.
  The abandonment stage reads these fields.
- Re-pickup: if a separated object re-enters a person bbox it goes through the
  carry trial again.  dropped_at is cleared so only the most-recent drop matters.

Throw / track-break recovery
-----------------------------
When a thrown object loses its ByteTrack ID mid-flight and lands as a new track_id,
the new ID would normally start with no owner and the abandonment machine would
never fire.  Ghost records prevent this:

- When an owned track disappears (not in current detections), a _GhostRecord is
  saved with the last-known class, position, and owner for REOWN_WINDOW_SEC seconds.
- When a *new* track of the same class appears within REOWN_RADIUS_PX of the ghost's
  last position within the time window, it inherits the ghost's owner_id.  If the
  original track was still "carried" when it disappeared (thrown mid-air), the
  landing location becomes the drop_location so the abandonment timers start
  immediately from landing.
- The ghost is consumed on first match so it can never reown multiple tracks.
- Debounce: if a ghost already exists near a disappearing track, its expiry and
  position are refreshed instead of creating a duplicate (reduces log spam when
  tracks flicker rapidly).

reown_map
---------
After each update() call, Associator.reown_map holds {new_track_id: old_track_id}
for every reown that happened this frame.  The AbandonmentMachine reads this to
migrate its internal _Track state so timers survive ID changes.
"""

import time as _time
from typing import Dict, List, Optional, Tuple

# ── ownership tuning ──────────────────────────────────────────────────────────
CARRY_FRAMES      = 5    # consecutive overlap frames to confirm ownership
HYSTERESIS_FRAMES = 20   # frames of grace period after overlap ends (~1-2 s at 10 fps)

# ── throw / track-break recovery ──────────────────────────────────────────────
REOWN_WINDOW_SEC = 4.0   # seconds to keep a ghost after a track disappears
REOWN_RADIUS_PX  = 250   # pixel radius around last position to match a re-detected track


# ── public state exposed to abandonment stage ─────────────────────────────────

class ObjectState:
    __slots__ = (
        "owner_id", "is_carried", "dropped_at", "drop_location",
        "_candidate", "_overlap_count", "_hysteresis",
    )

    def __init__(self) -> None:
        self.owner_id: Optional[int] = None
        self.is_carried: bool = False
        self.dropped_at: Optional[int] = None
        self.drop_location: Optional[Tuple[int, int]] = None
        self._candidate: Optional[int] = None
        self._overlap_count: int = 0
        self._hysteresis: int = 0


# ── ghost record (internal) ───────────────────────────────────────────────────

class _GhostRecord:
    """Memory of a disappeared owned track, held for REOWN_WINDOW_SEC seconds."""
    __slots__ = (
        "class_name", "owner_id", "last_center",
        "dropped_at", "drop_location", "expires_at", "old_track_id",
    )

    def __init__(
        self,
        class_name: str,
        owner_id: int,
        last_center: Tuple[int, int],
        dropped_at: Optional[int],
        drop_location: Optional[Tuple[int, int]],
        expires_at: float,
        old_track_id: int,
    ) -> None:
        self.class_name = class_name
        self.owner_id = owner_id
        self.last_center = last_center
        self.dropped_at = dropped_at
        self.drop_location = drop_location
        self.expires_at = expires_at
        self.old_track_id = old_track_id  # track_id of the original disappeared track


# ── main class ────────────────────────────────────────────────────────────────

class Associator:
    """Stateful per-session associator; one instance lives for the whole video run."""

    def __init__(
        self,
        carry_frames: int = CARRY_FRAMES,
        hysteresis_frames: int = HYSTERESIS_FRAMES,
    ) -> None:
        self.carry_frames = carry_frames
        self.hysteresis_frames = hysteresis_frames
        self.object_states: Dict[int, ObjectState] = {}
        self._class_map: Dict[int, str] = {}                    # track_id → class
        self._last_centers: Dict[int, Tuple[int, int]] = {}     # track_id → last bbox center
        self._prev_active_oids: set = set()                     # active object track_ids last frame
        self._ghosts: List[_GhostRecord] = []                   # recently disappeared owned tracks
        # Populated each frame: {new_track_id: old_track_id} for every ghost reown this frame.
        # Read by AbandonmentMachine to migrate timer state across ID changes.
        self.reown_map: Dict[int, int] = {}

    def update(self, frame_idx: int, detections: List[dict]) -> None:
        """Advance state for one frame.  detections is the raw list from detect_and_track."""
        now = _time.time()

        # Reset reown map for this frame
        self.reown_map.clear()

        # ── 1. expire old ghosts ───────────────────────────────────────────────
        self._ghosts = [g for g in self._ghosts if g.expires_at > now]

        persons = {
            d["track_id"]: d["bbox"]
            for d in detections
            if d["class"] == "person" and d.get("track_id") is not None
        }
        objects = [
            d for d in detections
            if d["class"] != "person" and d.get("track_id") is not None
        ]

        current_oids = {obj["track_id"] for obj in objects}

        # ── 2. ghost creation: record disappeared owned tracks ─────────────────
        for oid in (self._prev_active_oids - current_oids):
            state = self.object_states.get(oid)
            if state is None or state.owner_id is None:
                continue
            cls = self._class_map.get(oid)
            center = self._last_centers.get(oid)
            if cls is None or center is None:
                continue

            # Debounce: if a live ghost of the same class already sits near this
            # position, just refresh it rather than creating a duplicate entry.
            existing = _find_matching_ghost(self._ghosts, cls, center, now)
            if existing is not None:
                existing.last_center = center
                existing.expires_at = now + REOWN_WINDOW_SEC
                # Keep existing.old_track_id so the migration chain stays intact
            else:
                self._ghosts.append(_GhostRecord(
                    class_name=cls,
                    owner_id=state.owner_id,
                    last_center=center,
                    dropped_at=state.dropped_at,
                    drop_location=state.drop_location,
                    expires_at=now + REOWN_WINDOW_SEC,
                    old_track_id=oid,
                ))
                print(
                    f"[ASSOC] ghost created: track {oid} ({cls}) owned by {state.owner_id} "
                    f"last_pos={center} expires_in={REOWN_WINDOW_SEC:.0f}s"
                )

        self._prev_active_oids = current_oids

        # ── 3. per-object association update ──────────────────────────────────
        for obj in objects:
            oid: int = obj["track_id"]
            bbox: Tuple[int, int, int, int] = obj["bbox"]
            cx = (bbox[0] + bbox[2]) // 2
            cy = (bbox[1] + bbox[3]) // 2

            is_new_track = oid not in self.object_states
            state = self.object_states.setdefault(oid, ObjectState())

            # Keep bookkeeping current (used for ghost creation on future disappearance)
            self._class_map[oid] = obj["class"]
            self._last_centers[oid] = (cx, cy)

            # ── Ghost reown: inherit owner from a recently-disappeared track ──
            if is_new_track and state.owner_id is None:
                ghost = _find_matching_ghost(self._ghosts, obj["class"], (cx, cy), now)
                if ghost is not None:
                    dist = int(((cx - ghost.last_center[0]) ** 2 +
                                (cy - ghost.last_center[1]) ** 2) ** 0.5)
                    state.owner_id = ghost.owner_id
                    if ghost.drop_location is not None:
                        # Was already officially dropped before track broke
                        state.drop_location = ghost.drop_location
                        state.dropped_at = ghost.dropped_at
                    else:
                        # Vanished while still carried (thrown mid-air) — landing = drop point
                        state.drop_location = (cx, cy)
                        state.dropped_at = frame_idx
                    state.is_carried = False
                    # Record mapping so abandonment machine can migrate its _Track entry
                    self.reown_map[oid] = ghost.old_track_id
                    self._ghosts.remove(ghost)
                    print(
                        f"[ASSOC] reown: new track {oid} ({obj['class']}) "
                        f"← owner {ghost.owner_id}  dist={dist}px  "
                        f"drop={state.drop_location}  (was track {ghost.old_track_id})"
                    )

            overlapping = _overlapping_person(bbox, persons)

            if overlapping is not None:
                # Object is near/inside a person
                state._hysteresis = self.hysteresis_frames

                if state.is_carried:
                    pass  # already owned, stay carried
                else:
                    if state._candidate == overlapping:
                        state._overlap_count += 1
                    else:
                        state._candidate = overlapping
                        state._overlap_count = 1

                    if state._overlap_count >= self.carry_frames:
                        state.owner_id = overlapping
                        state.is_carried = True
                        state._candidate = None
                        state._overlap_count = 0
                        # Clear previous drop record (object was re-acquired)
                        state.dropped_at = None
                        state.drop_location = None

            else:
                # Object is not overlapping any person
                if state.is_carried:
                    state._hysteresis -= 1
                    if state._hysteresis <= 0:
                        state.is_carried = False
                        state.dropped_at = frame_idx
                        state.drop_location = (cx, cy)
                else:
                    # Not yet owned; reset trial if overlap is lost mid-trial
                    state._candidate = None
                    state._overlap_count = 0


# ── helpers ───────────────────────────────────────────────────────────────────

def _find_matching_ghost(
    ghosts: List[_GhostRecord],
    class_name: str,
    center: Tuple[int, int],
    now: float,
) -> Optional[_GhostRecord]:
    """
    Return the closest unexpired ghost matching class_name within REOWN_RADIUS_PX,
    or None.  Picks nearest when multiple qualify so the most-likely match wins.
    """
    cx, cy = center
    best: Optional[_GhostRecord] = None
    best_dist = float("inf")
    for g in ghosts:
        if g.class_name != class_name or g.expires_at <= now:
            continue
        dist = ((cx - g.last_center[0]) ** 2 + (cy - g.last_center[1]) ** 2) ** 0.5
        if dist <= REOWN_RADIUS_PX and dist < best_dist:
            best_dist = dist
            best = g
    return best


def _overlapping_person(
    obj_bbox: Tuple[int, int, int, int],
    persons: Dict[int, Tuple[int, int, int, int]],
) -> Optional[int]:
    """
    Return the person track_id whose bbox best contains the object, or None.

    Primary test: object center inside person bbox (robust for held objects).
    Fallback: object bbox overlaps person bbox by ≥30 % of the object's area.
    When multiple persons qualify, prefer the one with the largest bbox (nearest).
    """
    ox1, oy1, ox2, oy2 = obj_bbox
    ocx = (ox1 + ox2) // 2
    ocy = (oy1 + oy2) // 2

    best_id: Optional[int] = None
    best_area = 0

    for pid, (px1, py1, px2, py2) in persons.items():
        if px1 <= ocx <= px2 and py1 <= ocy <= py2:
            area = (px2 - px1) * (py2 - py1)
            if area > best_area:
                best_area = area
                best_id = pid

    if best_id is not None:
        return best_id

    # Fallback: significant bbox overlap
    obj_area = max((ox2 - ox1) * (oy2 - oy1), 1)
    for pid, (px1, py1, px2, py2) in persons.items():
        ix1, iy1 = max(ox1, px1), max(oy1, py1)
        ix2, iy2 = min(ox2, px2), min(oy2, py2)
        if ix2 > ix1 and iy2 > iy1:
            if (ix2 - ix1) * (iy2 - iy1) / obj_area >= 0.30:
                return pid

    return None
