import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

/**
 * Boundary string emitted by FFmpeg's `mpjpeg` muxer. The stream routes set
 * this on the `multipart/x-mixed-replace` Content-Type so the browser `<img>`
 * MJPEG parser lines up with the frame boundaries FFmpeg writes.
 */
export const MJPEG_BOUNDARY = "ffmpeg";

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Benign HEVC decoder chatter emitted when we join an H.265 stream mid-GOP
 * (before the first keyframe). It self-resolves once a keyframe arrives and
 * says nothing actionable, so the stream routes filter it out of their logs.
 */
export function isBenignDecoderNoise(line: string): boolean {
  return (
    /Could not find ref with POC/i.test(line) ||
    /Error constructing the frame RPS/i.test(line)
  );
}

/**
 * Open an RTSP source and transcode it to a browser-viewable MJPEG stream on
 * stdout. Replaces the old Python/OpenCV decoder — FFmpeg does the RTSP+JPEG
 * work directly, so no Python runtime is needed.
 *
 * Progress/errors go to stderr; the caller decides what to log.
 */
export function startFfmpegDecoder(rtspUrl: string): ChildProcessWithoutNullStreams {
  const decoder = spawn(
    FFMPEG_BIN,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-rtsp_transport", "tcp",
      // Drop the corrupt frames we get when joining an H.265 stream mid-GOP
      // (before the first keyframe) — silences the "Could not find ref with
      // POC / Error constructing the frame RPS" decoder warnings.
      "-fflags", "+discardcorrupt",
      "-i", rtspUrl,
      "-an", // drop audio
      "-f", "mpjpeg",
      "-q:v", "6", // JPEG quality (2=best … 31=worst)
      "-",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  // No stdin is used; close it so FFmpeg doesn't wait on it.
  decoder.stdin.end();
  return decoder;
}
