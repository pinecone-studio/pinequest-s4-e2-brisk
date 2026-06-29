import type { Detection } from "../yoloDecode";
import { AbandonmentMachine, type LitteringEvent } from "./abandonment";
import { Associator } from "./association";
import { isCarriableClass, PERSON_CLASS } from "./carriableClasses";
import { SimpleTracker, type RawDetection } from "./simpleTracker";

export type { LitteringEvent } from "./abandonment";

export class CameraLitteringSession {
  private readonly tracker = new SimpleTracker();
  private readonly associator = new Associator();
  private readonly abandonment = new AbandonmentMachine();
  private frameIdx = 0;

  process(inputs: RawDetection[]): {
    events: LitteringEvent[];
    overlayDets: Detection[];
  } {
    this.frameIdx += 1;
    const tracked = this.tracker.update(inputs);
    this.associator.update(this.frameIdx, tracked);

    const events = this.abandonment.update(
      Date.now() / 1000,
      tracked,
      this.associator.object_states,
      this.associator.reown_map,
    );

    const overlayDets: Detection[] = [];

    for (const det of tracked) {
      if (det.class === PERSON_CLASS) {
        overlayDets.push({
          label: "Person",
          confidence: det.conf,
          box: det.bbox,
        });
        continue;
      }

      const state = this.associator.object_states.get(det.track_id);
      if (!state) continue;

      if (state.is_carried) {
        overlayDets.push({
          label: det.class,
          confidence: det.conf,
          box: det.bbox,
        });
      } else if (state.dropped_at !== null && state.drop_location) {
        const [cx, cy] = state.drop_location;
        const half = 0.02;
        overlayDets.push({
          label: "Dropped",
          confidence: det.conf,
          box: [cx - half, cy - half, cx + half, cy + half],
        });
      }
    }

    for (const event of events) {
      if (!event.drop_location) continue;
      const [cx, cy] = event.drop_location;
      const half = 0.03;
      overlayDets.push({
        label: "Littering",
        confidence: 0.95,
        box: [cx - half, cy - half, cx + half, cy + half],
      });
    }

    return { events, overlayDets };
  }
}

export function buildLitteringInputs(
  cocoDets: Array<{ label: string; confidence: number; box: [number, number, number, number] }>,
  litterDets: Array<{ label: string; confidence: number; box: [number, number, number, number] }>,
): RawDetection[] {
  const inputs: RawDetection[] = [];

  for (const det of cocoDets) {
    const cls = det.label.toLowerCase();
    if (cls === PERSON_CLASS || isCarriableClass(cls)) {
      inputs.push({ class: cls, box: det.box, conf: det.confidence });
    }
  }

  for (const det of litterDets) {
    inputs.push({ class: "bottle", box: det.box, conf: det.confidence });
  }

  return dedupeByIou(inputs, 0.45);
}

function iou(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

function dedupeByIou(dets: RawDetection[], threshold: number): RawDetection[] {
  const sorted = [...dets].sort((a, b) => b.conf - a.conf);
  const kept: RawDetection[] = [];

  for (const det of sorted) {
    const duplicate = kept.some(
      (k) => k.class === det.class && iou(k.box, det.box) > threshold,
    );
    if (!duplicate) kept.push(det);
  }

  return kept;
}
