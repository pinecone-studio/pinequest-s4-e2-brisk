"""
Abandonment state machine for the littering pipeline.

Consumes per-frame detections and the Associator's object_states to drive each
tracked object through:

    IDLE → CARRIED → DROPPED → STATIONARY → OWNER_DEPARTED → ALERTED

Timers are wall-clock seconds so they are independent of inference frame-rate.

Usage
-----
    machine = AbandonmentMachine()
    ...
    events = machine.update(time.time(), detections, associator.object_states,
                            associator.reown_map)
    for evt in events:
        print(evt)   # LitteringEvent

Safety rules baked in
---------------------
- Objects that were NEVER owned (owner_id is None) never leave IDLE → no alert.
- Re-pickup at any state resets to CARRIED and cancels all timers.
- Object disappears before ALERTED → reset to IDLE only after DISAPPEAR_TOLERANCE_SEC
  of continuous absence (brief flicker does NOT reset the stationary/departure clock).

Track-ID-change survival
------------------------
When ByteTrack re-assigns a new track_id to the same physical object (ghost reown),
the Associator populates reown_map = {new_id: old_id}.  update() migrates the
internal _Track entry from old_id to new_id before processing, so the stationary
timer and departure clock survive without interruption.
"""

from __future__ import annotations

import time as _time
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Tuple

# ── tuneable defaults ──────────────────────────────────────────────────────────
T_STATIONARY: float = 3.0    # seconds object must stay still after separation
T_DEPARTURE: float  = 5.0    # seconds owner must be absent after object is still
MOVEMENT_PX: int    = 15     # pixel displacement that resets the stationary timer
DISAPPEAR_TOLERANCE_SEC: float = 3.0  # grace window: don't reset state on brief flicker


# ── public types ──────────────────────────────────────────────────────────────

class AbanState(str, Enum):
    IDLE            = "IDLE"
    CARRIED         = "CARRIED"
    DROPPED         = "DROPPED"        # separated; stationarity timer running
    STATIONARY      = "STATIONARY"     # still long enough; departure timer running
    OWNER_DEPARTED  = "OWNER_DEPARTED" # both timers done; about to fire
    ALERTED         = "ALERTED"        # event emitted; will not re-fire


@dataclass
class LitteringEvent:
    object_id: int
    owner_id: int
    drop_location: Optional[Tuple[int, int]]
    timestamp: float  # time.time() at moment of alert

    def __str__(self) -> str:
        ts = _time.strftime("%H:%M:%S", _time.localtime(self.timestamp))
        return (
            f"[LITTERING] object={self.object_id}  owner={self.owner_id}"
            f"  loc={self.drop_location}  time={ts}"
        )


# ── internal per-track state ──────────────────────────────────────────────────

class _Track:
    __slots__ = (
        "state", "owner_id", "drop_location",
        "stationary_since", "last_center",
        "owner_absent_since", "last_seen",
    )

    def __init__(self) -> None:
        self.state: AbanState = AbanState.IDLE
        self.owner_id: Optional[int] = None
        self.drop_location: Optional[Tuple[int, int]] = None
        self.stationary_since: Optional[float] = None
        self.last_center: Optional[Tuple[int, int]] = None
        self.owner_absent_since: Optional[float] = None
        self.last_seen: Optional[float] = None  # wall-clock time of last visible frame


# ── main class ────────────────────────────────────────────────────────────────

class AbandonmentMachine:
    """
    One instance per run session.  Call update() once per frame.
    """

    def __init__(
        self,
        t_stationary: float = T_STATIONARY,
        t_departure: float = T_DEPARTURE,
        movement_px: int = MOVEMENT_PX,
        t_disappear: float = DISAPPEAR_TOLERANCE_SEC,
    ) -> None:
        self.t_stationary = t_stationary
        self.t_departure = t_departure
        self.movement_px = movement_px
        self.t_disappear = t_disappear
        self._tracks: Dict[int, _Track] = {}

    def get_state(self, object_id: int) -> Optional[AbanState]:
        t = self._tracks.get(object_id)
        return t.state if t else None

    def update(
        self,
        now: float,
        detections: List[dict],
        assoc_states: dict,           # Associator.object_states
        reown_map: Optional[Dict[int, int]] = None,  # Associator.reown_map
    ) -> List[LitteringEvent]:
        """
        Advance the state machine for one frame.

        Returns a (usually empty) list of newly-fired LitteringEvents.
        """
        # ── migrate _Track entries for reowned tracks ──────────────────────────
        # If the Associator matched a new track_id to a ghost (old track_id), carry
        # over the existing _Track so timers don't reset on an ID change.
        if reown_map:
            for new_id, old_id in reown_map.items():
                if old_id in self._tracks and new_id not in self._tracks:
                    self._tracks[new_id] = self._tracks.pop(old_id)
                    print(
                        f"[ABAN] migrated track state: {old_id} → {new_id} "
                        f"(state={self._tracks[new_id].state})"
                    )

        visible_persons: set = {
            d["track_id"]
            for d in detections
            if d["class"] == "person" and d.get("track_id") is not None
        }
        object_centers: Dict[int, Tuple[int, int]] = {
            d["track_id"]: (
                (d["bbox"][0] + d["bbox"][2]) // 2,
                (d["bbox"][1] + d["bbox"][3]) // 2,
            )
            for d in detections
            if d["class"] != "person" and d.get("track_id") is not None
        }

        events: List[LitteringEvent] = []

        for oid, assoc in assoc_states.items():
            # Objects that were never owned never alert
            if assoc.owner_id is None:
                continue

            track = self._tracks.setdefault(oid, _Track())
            center = object_centers.get(oid)  # None → not visible this frame

            # Track last-seen time whenever the object is actually detected
            if center is not None:
                track.last_seen = now

            # ── universal re-pickup guard ──────────────────────────────────────
            if assoc.is_carried:
                if track.state != AbanState.ALERTED:
                    track.state = AbanState.CARRIED
                    track.owner_id = assoc.owner_id
                    track.stationary_since = None
                    track.last_center = None
                    track.owner_absent_since = None
                continue

            # ── per-state transitions ──────────────────────────────────────────

            if track.state == AbanState.IDLE:
                if assoc.owner_id is not None:
                    track.state = AbanState.CARRIED
                    track.owner_id = assoc.owner_id

            elif track.state == AbanState.CARRIED:
                # Wait for association to record a separation
                if not assoc.is_carried and assoc.dropped_at is not None:
                    track.state = AbanState.DROPPED
                    track.drop_location = assoc.drop_location
                    track.stationary_since = now
                    track.last_center = center
                    track.owner_absent_since = None

            elif track.state == AbanState.DROPPED:
                if center is None:
                    # Tolerate brief detection gaps — only reset after sustained absence
                    if track.last_seen is not None and now - track.last_seen > self.t_disappear:
                        track.state = AbanState.IDLE
                    # else: keep state and let the stationary timer keep running
                    continue

                # Movement check: any frame with displacement > threshold resets timer
                if track.last_center is not None:
                    dx = abs(center[0] - track.last_center[0])
                    dy = abs(center[1] - track.last_center[1])
                    if max(dx, dy) > self.movement_px:
                        track.stationary_since = now
                track.last_center = center

                if now - (track.stationary_since or now) >= self.t_stationary:
                    track.state = AbanState.STATIONARY
                    track.owner_absent_since = None

            elif track.state == AbanState.STATIONARY:
                if center is None:
                    # Same tolerance: brief flicker doesn't cancel the departure clock
                    if track.last_seen is not None and now - track.last_seen > self.t_disappear:
                        track.state = AbanState.IDLE
                    continue

                # Departure check: start/reset clock based on owner visibility
                if track.owner_id in visible_persons:
                    track.owner_absent_since = None
                else:
                    if track.owner_absent_since is None:
                        track.owner_absent_since = now
                    if now - track.owner_absent_since >= self.t_departure:
                        track.state = AbanState.OWNER_DEPARTED

            elif track.state == AbanState.OWNER_DEPARTED:
                events.append(LitteringEvent(
                    object_id=oid,
                    owner_id=track.owner_id,
                    drop_location=track.drop_location or assoc.drop_location,
                    timestamp=now,
                ))
                track.state = AbanState.ALERTED

            # AbanState.ALERTED: no-op — event already emitted, won't re-fire

        return events
