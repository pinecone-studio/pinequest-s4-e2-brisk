export interface EvidenceEvent {
  id: string;
  source: string; // camera that captured the snapshot, e.g. "Webcam AI"
  label: string; // e.g. "Smoking"
  confidence: number; // 0..1
  time: number; // Date.now()
  thumb: string; // data URL preview
  savedPath: string | null; // server path under evidence/, or null if save failed
  saveError?: string;
  note?: string; // the VLM's free-text reasoning — "what the AI thought" for this frame
  info?: boolean; // true = AI observation only (no violation, not saved to disk)
}
