export type NormBox = [number, number, number, number];

export interface RawDetection {
  class: string;
  box: NormBox;
  conf: number;
}

export interface TrackedDetection {
  class: string;
  track_id: number;
  bbox: NormBox;
  conf: number;
}

function iou(a: NormBox, b: NormBox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

interface InternalTrack {
  id: number;
  className: string;
  box: NormBox;
  missed: number;
}

export class SimpleTracker {
  private tracks: InternalTrack[] = [];
  private nextId = 1;

  update(detections: RawDetection[]): TrackedDetection[] {
    const matched = new Set<number>();
    const results: TrackedDetection[] = [];

    for (const det of detections) {
      let bestIdx = -1;
      let bestIou = 0.35;

      for (let i = 0; i < this.tracks.length; i += 1) {
        if (matched.has(i)) continue;
        if (this.tracks[i].className !== det.class) continue;
        const score = iou(this.tracks[i].box, det.box);
        if (score > bestIou) {
          bestIou = score;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        matched.add(bestIdx);
        const track = this.tracks[bestIdx];
        track.box = det.box;
        track.missed = 0;
        results.push({
          class: det.class,
          track_id: track.id,
          bbox: det.box,
          conf: det.conf,
        });
      } else {
        const id = this.nextId;
        this.nextId += 1;
        this.tracks.push({
          id,
          className: det.class,
          box: det.box,
          missed: 0,
        });
        results.push({
          class: det.class,
          track_id: id,
          bbox: det.box,
          conf: det.conf,
        });
      }
    }

    for (let i = 0; i < this.tracks.length; i += 1) {
      if (!matched.has(i)) {
        this.tracks[i].missed += 1;
      }
    }

    this.tracks = this.tracks.filter((t) => t.missed <= 8);
    return results;
  }
}
