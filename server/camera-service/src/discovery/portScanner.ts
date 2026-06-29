import net from "net";
import { PORT_PROBE_TIMEOUT_MS, PORT_SCAN_CONCURRENCY } from "../config";

export async function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export async function scanHostPorts(
  host: string,
  ports: readonly number[],
): Promise<number[]> {
  const open: number[] = [];
  await Promise.all(
    ports.map(async (port) => {
      if (await probePort(host, port)) {
        open.push(port);
      }
    }),
  );
  return open.sort((a, b) => a - b);
}

export async function scanSubnetPorts(
  hosts: string[],
  ports: readonly number[],
  onHostResult?: (host: string, openPorts: number[]) => void | Promise<void>,
): Promise<Map<string, number[]>> {
  const results = new Map<string, number[]>();
  let index = 0;

  async function worker() {
    while (index < hosts.length) {
      const current = hosts[index];
      index += 1;
      const openPorts = await scanHostPorts(current, ports);
      if (openPorts.length > 0) {
        results.set(current, openPorts);
        await onHostResult?.(current, openPorts);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(PORT_SCAN_CONCURRENCY, hosts.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
