import { REOWN_RADIUS_NORM } from "./constants";

export const CARRY_FRAMES = 4;
export const HYSTERESIS_FRAMES = 12;
export const REOWN_WINDOW_SEC = 4.0;

export interface ObjectState {
  owner_id: number | null;
  is_carried: boolean;
  dropped_at: number | null;
  drop_location: [number, number] | null;
  _candidate: number | null;
  _overlap_count: number;
  _hysteresis: number;
}

interface GhostRecord {
  class_name: string;
  owner_id: number;
  last_center: [number, number];
  dropped_at: number | null;
  drop_location: [number, number] | null;
  expires_at: number;
  old_track_id: number;
}

type NormBox = [number, number, number, number];

function centerOf(box: NormBox): [number, number] {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

function overlappingPerson(
  objBox: NormBox,
  persons: Map<number, NormBox>,
): number | null {
  const ocx = (objBox[0] + objBox[2]) / 2;
  const ocy = (objBox[1] + objBox[3]) / 2;

  let bestId: number | null = null;
  let bestArea = 0;

  for (const [pid, personBox] of persons) {
    const [px1, py1, px2, py2] = personBox;
    if (px1 <= ocx && ocx <= px2 && py1 <= ocy && ocy <= py2) {
      const area = (px2 - px1) * (py2 - py1);
      if (area > bestArea) {
        bestArea = area;
        bestId = pid;
      }
    }
  }

  if (bestId !== null) return bestId;

  const objArea = Math.max((objBox[2] - objBox[0]) * (objBox[3] - objBox[1]), 1e-6);
  for (const [pid, personBox] of persons) {
    const [ox1, oy1, ox2, oy2] = objBox;
    const [px1, py1, px2, py2] = personBox;
    const ix1 = Math.max(ox1, px1);
    const iy1 = Math.max(oy1, py1);
    const ix2 = Math.min(ox2, px2);
    const iy2 = Math.min(oy2, py2);
    if (ix2 > ix1 && iy2 > iy1) {
      if (((ix2 - ix1) * (iy2 - iy1)) / objArea >= 0.3) {
        return pid;
      }
    }
  }

  return null;
}

function findMatchingGhost(
  ghosts: GhostRecord[],
  className: string,
  center: [number, number],
  now: number,
): GhostRecord | null {
  let best: GhostRecord | null = null;
  let bestDist = Infinity;
  for (const ghost of ghosts) {
    if (ghost.class_name !== className || ghost.expires_at <= now) continue;
    const dist = Math.hypot(center[0] - ghost.last_center[0], center[1] - ghost.last_center[1]);
    if (dist <= REOWN_RADIUS_NORM && dist < bestDist) {
      bestDist = dist;
      best = ghost;
    }
  }
  return best;
}

export class Associator {
  readonly object_states = new Map<number, ObjectState>();
  readonly reown_map = new Map<number, number>();

  private readonly classMap = new Map<number, string>();
  private readonly lastCenters = new Map<number, [number, number]>();
  private prevActiveOids = new Set<number>();
  private ghosts: GhostRecord[] = [];

  constructor(
    private readonly carryFrames = CARRY_FRAMES,
    private readonly hysteresisFrames = HYSTERESIS_FRAMES,
  ) {}

  update(
    frameIdx: number,
    detections: Array<{ class: string; track_id: number; bbox: NormBox }>,
  ): void {
    const now = Date.now() / 1000;
    this.reown_map.clear();
    this.ghosts = this.ghosts.filter((g) => g.expires_at > now);

    const persons = new Map<number, NormBox>();
    const objects: Array<{ class: string; track_id: number; bbox: NormBox }> = [];

    for (const det of detections) {
      if (det.class === "person") {
        persons.set(det.track_id, det.bbox);
      } else {
        objects.push(det);
      }
    }

    const currentOids = new Set(objects.map((o) => o.track_id));

    for (const oid of this.prevActiveOids) {
      if (currentOids.has(oid)) continue;
      const state = this.object_states.get(oid);
      if (!state || state.owner_id === null) continue;
      const cls = this.classMap.get(oid);
      const center = this.lastCenters.get(oid);
      if (!cls || !center) continue;

      const existing = findMatchingGhost(this.ghosts, cls, center, now);
      if (existing) {
        existing.last_center = center;
        existing.expires_at = now + REOWN_WINDOW_SEC;
      } else {
        this.ghosts.push({
          class_name: cls,
          owner_id: state.owner_id,
          last_center: center,
          dropped_at: state.dropped_at,
          drop_location: state.drop_location,
          expires_at: now + REOWN_WINDOW_SEC,
          old_track_id: oid,
        });
      }
    }

    this.prevActiveOids = currentOids;

    for (const obj of objects) {
      const oid = obj.track_id;
      const center = centerOf(obj.bbox);
      const isNew = !this.object_states.has(oid);
      const state = this.object_states.get(oid) ?? createObjectState();
      this.object_states.set(oid, state);

      this.classMap.set(oid, obj.class);
      this.lastCenters.set(oid, center);

      if (isNew && state.owner_id === null) {
        const ghost = findMatchingGhost(this.ghosts, obj.class, center, now);
        if (ghost) {
          state.owner_id = ghost.owner_id;
          if (ghost.drop_location) {
            state.drop_location = ghost.drop_location;
            state.dropped_at = ghost.dropped_at;
          } else {
            state.drop_location = center;
            state.dropped_at = frameIdx;
          }
          state.is_carried = false;
          this.reown_map.set(oid, ghost.old_track_id);
          this.ghosts = this.ghosts.filter((g) => g !== ghost);
        }
      }

      const overlapping = overlappingPerson(obj.bbox, persons);

      if (overlapping !== null) {
        state._hysteresis = this.hysteresisFrames;
        if (!state.is_carried) {
          if (state._candidate === overlapping) {
            state._overlap_count += 1;
          } else {
            state._candidate = overlapping;
            state._overlap_count = 1;
          }
          if (state._overlap_count >= this.carryFrames) {
            state.owner_id = overlapping;
            state.is_carried = true;
            state._candidate = null;
            state._overlap_count = 0;
            state.dropped_at = null;
            state.drop_location = null;
          }
        }
      } else if (state.is_carried) {
        state._hysteresis -= 1;
        if (state._hysteresis <= 0) {
          state.is_carried = false;
          state.dropped_at = frameIdx;
          state.drop_location = center;
        }
      } else {
        state._candidate = null;
        state._overlap_count = 0;
      }
    }
  }
}

function createObjectState(): ObjectState {
  return {
    owner_id: null,
    is_carried: false,
    dropped_at: null,
    drop_location: null,
    _candidate: null,
    _overlap_count: 0,
    _hysteresis: 0,
  };
}
