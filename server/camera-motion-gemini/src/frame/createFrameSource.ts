import type { FrameSource } from "./FrameSource";
import { MockFrameSource } from "./mockFrameSource";

/**
 * Factory that maps a camera `source` string to a concrete FrameSource.
 *
 * Supported prefixes today:
 *   mock:<seed>  — synthetic frames (default for development)
 *
 * ---------------------------------------------------------------------------
 * HOW TO SWAP IN REAL STREAMS
 * ---------------------------------------------------------------------------
 *
 * MJPEG snapshot URL (HTTP single-frame endpoint):
 *
 *   import { MjpegFrameSource } from "./mjpegFrameSource";
 *   if (source.startsWith("mjpeg:")) {
 *     return new MjpegFrameSource({ url: source.slice("mjpeg:".length) });
 *   }
 *
 *   // mjpegFrameSource sketch:
 *   //   const res = await fetch(this.url, { signal: AbortSignal.timeout(5000) });
 *   //   const encoded = Buffer.from(await res.arrayBuffer());
 *   //   const { data, info } = await sharp(encoded).resize(320, 240).raw().toBuffer({ resolveWithObject: true });
 *   //   return { width: info.width, height: info.height, rgba: data, encoded, mimeType: "image/jpeg" };
 *
 * RTSP (requires ffmpeg on PATH or @ffmpeg-installer/ffmpeg):
 *
 *   import { RtspFrameSource } from "./rtspFrameSource";
 *   if (source.startsWith("rtsp:")) {
 *     return new RtspFrameSource({ url: source.slice("rtsp:".length) });
 *   }
 *
 *   // rtspFrameSource sketch — spawn ffmpeg to emit one JPEG per capture():
 *   //   ffmpeg -rtsp_transport tcp -i <url> -frames:v 1 -f image2 pipe:1
 *   //   Decode pipe stdout with sharp the same way as MJPEG above.
 *
 * ONVIF / IP camera SDK:
 *   Wrap the vendor snapshot API and normalize output to FrameData in capture().
 */
export function createFrameSource(source: string): FrameSource {
  if (source.startsWith("mock:")) {
    const seed = Number.parseInt(source.slice("mock:".length), 10);
    return new MockFrameSource({ seed: Number.isFinite(seed) ? seed : 0 });
  }

  throw new Error(
    `Unsupported frame source "${source}". Use mock:<seed> for development or extend createFrameSource() for real streams.`,
  );
}
