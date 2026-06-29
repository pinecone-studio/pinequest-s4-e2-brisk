export interface EvidenceEvent {
  id: string;
  source: string; // camera that captured the snapshot, e.g. "Webcam AI"
  label: string; // e.g. "Smoking"
  confidence: number; // 0..1
  time: number; // Date.now()
  thumb: string; // data URL preview
  savedPath: string | null; // server path under evidence/, or null if save failed
  saveError?: string;
}
