export type FrameSource = HTMLVideoElement | HTMLImageElement;

export function getSourceSize(source: FrameSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  return { width: source.naturalWidth, height: source.naturalHeight };
}

export function isSourceReady(source: FrameSource): boolean {
  const { width, height } = getSourceSize(source);
  return width > 0 && height > 0;
}
