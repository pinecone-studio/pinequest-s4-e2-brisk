import {
  DISAPPEAR_TOLERANCE_SEC,
  MOVEMENT_NORM,
  T_DEPARTURE,
  T_STATIONARY,
} from "./constants";

export enum AbanState {
  IDLE = "IDLE",
  CARRIED = "CARRIED",
  DROPPED = "DROPPED",
  STATIONARY = "STATIONARY",
  OWNER_DEPARTED = "OWNER_DEPARTED",
  ALERTED = "ALERTED",
}

export interface LitteringEvent {
  object_id: number;
  owner_id: number;
  drop_location: [number, number] | null;
  timestamp: number;
}

interface TrackState {
  state: AbanState;
  owner_id: number | null;
  drop_location: [number, number] | null;
  stationary_since: number | null;
  last_center: [number, number] | null;
  owner_absent_since: number | null;
  last_seen: number | null;
}

type NormBox = [number, number, number, number];

export class AbandonmentMachine {
  private readonly tracks = new Map<number, TrackState>();

  constructor(
    private readonly tStationary = T_STATIONARY,
    private readonly tDeparture = T_DEPARTURE,
    private readonly movementNorm = MOVEMENT_NORM,
    private readonly tDisappear = DISAPPEAR_TOLERANCE_SEC,
  ) {}

  update(
    now: number,
    detections: Array<{ class: string; track_id: number; bbox: NormBox }>,
    assocStates: Map<
      number,
      {
        owner_id: number | null;
        is_carried: boolean;
        dropped_at: number | null;
        drop_location: [number, number] | null;
      }
    >,
    reownMap: Map<number, number>,
  ): LitteringEvent[] {
    for (const [newId, oldId] of reownMap) {
      const existing = this.tracks.get(oldId);
      if (existing && !this.tracks.has(newId)) {
        this.tracks.set(newId, existing);
        this.tracks.delete(oldId);
      }
    }

    const visiblePersons = new Set(
      detections.filter((d) => d.class === "person").map((d) => d.track_id),
    );

    const objectCenters = new Map<number, [number, number]>();
    for (const det of detections) {
      if (det.class === "person") continue;
      objectCenters.set(det.track_id, [
        (det.bbox[0] + det.bbox[2]) / 2,
        (det.bbox[1] + det.bbox[3]) / 2,
      ]);
    }

    const events: LitteringEvent[] = [];

    for (const [oid, assoc] of assocStates) {
      if (assoc.owner_id === null) continue;

      const track = this.tracks.get(oid) ?? createTrackState();
      this.tracks.set(oid, track);
      const center = objectCenters.get(oid) ?? null;

      if (center) {
        track.last_seen = now;
      }

      if (assoc.is_carried) {
        if (track.state !== AbanState.ALERTED) {
          track.state = AbanState.CARRIED;
          track.owner_id = assoc.owner_id;
          track.stationary_since = null;
          track.last_center = null;
          track.owner_absent_since = null;
        }
        continue;
      }

      if (track.state === AbanState.IDLE) {
        if (assoc.owner_id !== null) {
          track.state = AbanState.CARRIED;
          track.owner_id = assoc.owner_id;
        }
      } else if (track.state === AbanState.CARRIED) {
        if (!assoc.is_carried && assoc.dropped_at !== null) {
          track.state = AbanState.DROPPED;
          track.drop_location = assoc.drop_location;
          track.stationary_since = now;
          track.last_center = center;
          track.owner_absent_since = null;
        }
      } else if (track.state === AbanState.DROPPED) {
        if (!center) {
          if (track.last_seen !== null && now - track.last_seen > this.tDisappear) {
            track.state = AbanState.IDLE;
          }
          continue;
        }

        if (track.last_center) {
          const dx = Math.abs(center[0] - track.last_center[0]);
          const dy = Math.abs(center[1] - track.last_center[1]);
          if (Math.max(dx, dy) > this.movementNorm) {
            track.stationary_since = now;
          }
        }
        track.last_center = center;

        if (now - (track.stationary_since ?? now) >= this.tStationary) {
          track.state = AbanState.STATIONARY;
          track.owner_absent_since = null;
        }
      } else if (track.state === AbanState.STATIONARY) {
        if (!center) {
          if (track.last_seen !== null && now - track.last_seen > this.tDisappear) {
            track.state = AbanState.IDLE;
          }
          continue;
        }

        if (track.owner_id !== null && visiblePersons.has(track.owner_id)) {
          track.owner_absent_since = null;
        } else {
          if (track.owner_absent_since === null) {
            track.owner_absent_since = now;
          }
          if (now - track.owner_absent_since >= this.tDeparture) {
            track.state = AbanState.OWNER_DEPARTED;
          }
        }
      } else if (track.state === AbanState.OWNER_DEPARTED) {
        events.push({
          object_id: oid,
          owner_id: track.owner_id ?? assoc.owner_id ?? 0,
          drop_location: track.drop_location ?? assoc.drop_location,
          timestamp: now,
        });
        track.state = AbanState.ALERTED;
      }
    }

    return events;
  }
}

function createTrackState(): TrackState {
  return {
    state: AbanState.IDLE,
    owner_id: null,
    drop_location: null,
    stationary_since: null,
    last_center: null,
    owner_absent_since: null,
    last_seen: null,
  };
}
