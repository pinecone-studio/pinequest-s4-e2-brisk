import fs from "fs";
import path from "path";

/**
 * Resolve the Python interpreter used to run streaming/decoder scripts.
 *
 * Prefers the project-local virtualenv (which has OpenCV installed) so the
 * stream routes don't depend on a global `python3`. On Windows, a bare
 * `python3` resolves to the Microsoft Store stub, which produces no output
 * when spawned non-interactively and silently breaks the decoder.
 */
export function resolvePythonBin(): string {
  const cwd = process.cwd();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(cwd, "venv", "Scripts", "python.exe"),
          path.join(cwd, ".venv", "Scripts", "python.exe"),
        ]
      : [
          path.join(cwd, "venv", "bin", "python"),
          path.join(cwd, ".venv", "bin", "python"),
        ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fall back to a PATH lookup. Avoid `python3` on Windows (Store stub).
  return process.platform === "win32" ? "python" : "python3";
}
