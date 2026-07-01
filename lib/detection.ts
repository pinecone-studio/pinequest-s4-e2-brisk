/**
 * A single detection returned by the vision backend (Gemini), in the app's
 * normalized contract: label + confidence + a box in [0,1] coordinates.
 */
export interface Detection {
  label: string;
  confidence: number;
  box: [number, number, number, number]; // x1, y1, x2, y2 normalized [0,1]
}
