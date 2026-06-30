export const CARRIABLE_CLASSES = new Set([
  "bottle",
  "cup",
  "backpack",
  "handbag",
  "suitcase",
  "litter",
]);

export const PERSON_CLASS = "person";

export function isCarriableClass(name: string): boolean {
  return CARRIABLE_CLASSES.has(name.toLowerCase());
}
