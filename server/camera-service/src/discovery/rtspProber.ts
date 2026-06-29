import net from "net";
import { DEFAULT_CREDENTIALS, RTSP_PATH_CANDIDATES } from "../config";

const PROBE_TIMEOUT_MS = 1500;

function buildRtspUrl(
  host: string,
  port: number,
  path: string,
  username?: string,
  password?: string,
): string {
  const auth =
    username !== undefined
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? "")}@`
      : "";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `rtsp://${auth}${host}:${port}${normalizedPath}`;
}

async function describeRoute(
  host: string,
  port: number,
  path: string,
  username: string,
  password: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      const request = [
        `DESCRIBE rtsp://${username}:${password}@${host}:${port}${path} RTSP/1.0`,
        "CSeq: 1",
        "User-Agent: Aegis/1.0",
        "",
        "",
      ].join("\r\n");
      socket.write(request);
    });
    socket.once("data", (chunk) => {
      finish(chunk.toString("utf8").includes("200 OK"));
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export async function probeRtspUrl(host: string, port: number): Promise<string> {
  for (const path of RTSP_PATH_CANDIDATES) {
    for (const cred of DEFAULT_CREDENTIALS) {
      if (await describeRoute(host, port, path, cred.username, cred.password)) {
        return buildRtspUrl(host, port, path, cred.username, cred.password);
      }
    }
  }
  return buildRtspUrl(host, port, RTSP_PATH_CANDIDATES[0]);
}
