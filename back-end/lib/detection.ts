/** A single detection returned by Gemini — label + confidence only (no bounding boxes). */
export interface Detection {
  label: string;
  confidence: number;
}
