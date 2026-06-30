import { Detection } from "./yoloDecode";
import {
  TEMPORAL_MIN_HITS,
  TEMPORAL_WINDOW,
} from "./modelConfig";

const GATED_LABELS = ["Cigarette", "Vape", "Litter"] as const;

const windows = new Map<string, boolean[]>();

function pushHit(label: string, hit: boolean): number {
  let w = windows.get(label);
  if (!w) {
    w = [];
    windows.set(label, w);
  }
  w.push(hit);
  if (w.length > TEMPORAL_WINDOW) w.shift();
  return w.filter(Boolean).length;
}

/** Only surface smoking/litter after consecutive frame hits (reduces single-frame FPs). */
export function applyTemporalFilter(detections: Detection[]): Detection[] {
  const persons = detections.filter((d) => d.label === "Person");
  const confirmed: Detection[] = [];

  for (const label of GATED_LABELS) {
    const best = detections
      .filter((d) => d.label === label)
      .sort((a, b) => b.confidence - a.confidence)[0];

    const hits = pushHit(label, !!best);
    if (hits >= TEMPORAL_MIN_HITS && best) {
      confirmed.push(best);
    }
  }

  return [...persons, ...confirmed];
}

export function resetTemporalFilter(): void {
  windows.clear();
}
