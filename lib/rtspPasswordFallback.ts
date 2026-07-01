// Passwords to try (in addition to the one embedded in the URL) when a camera
// rejects auth with 401. Configurable via RTSP_PASSWORDS (comma-separated).
export const FALLBACK_PASSWORDS = (process.env.RTSP_PASSWORDS ?? "123456,hk123456")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** The URL's own password first, then env fallbacks (de-duplicated). */
export function buildPasswordCandidates(rtspUrl: string): string[] {
  let originalPassword = "";
  try {
    originalPassword = new URL(rtspUrl).password;
  } catch {
    return [""];
  }
  return dedupe([originalPassword, ...FALLBACK_PASSWORDS]);
}

/** Rebuild an RTSP URL with a different password, keeping scheme/user/host/port/path. */
export function applyPasswordToRtspUrl(rtspUrl: string, password: string): string {
  const parsed = new URL(rtspUrl);
  parsed.password = password;
  return parsed.toString();
}
