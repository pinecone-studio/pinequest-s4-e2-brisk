import os from "os";

/**
 * Skip APIPA / link-local addresses (169.254.0.0/16). These appear on adapters
 * with no DHCP lease (disconnected NICs, virtual/Hyper-V/WSL switches) and never
 * host cameras — scanning that dead /24 keeps discovery "running" past the
 * client's poll window and surfaces as a bogus "scan timed out".
 */
function isScannableIpv4(address: string): boolean {
  return !address.startsWith("169.254.");
}

export function getAllLocalSubnets(): string[] {
  const sockets = os.networkInterfaces();
  const subnets = new Set<string>();

  for (const entries of Object.values(sockets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!isScannableIpv4(entry.address)) continue;
      const octets = entry.address.split(".");
      if (octets.length !== 4) continue;
      subnets.add(`${octets[0]}.${octets[1]}.${octets[2]}.0/24`);
    }
  }

  if (subnets.size === 0) {
    throw new Error("Could not detect a non-loopback local IP address");
  }

  return Array.from(subnets).sort((a, b) => {
    const aIsCameraLan = a.startsWith("192.168.1.") || a.startsWith("10.");
    const bIsCameraLan = b.startsWith("192.168.1.") || b.startsWith("10.");
    if (aIsCameraLan && !bIsCameraLan) return -1;
    if (!aIsCameraLan && bIsCameraLan) return 1;
    return a.localeCompare(b);
  });
}

export function detectLocalIp(): string {
  const subnets = getAllLocalSubnets();
  const preferred = subnets.find((s) => s.startsWith("192.168.1.")) ?? subnets[0];
  const octets = preferred.replace(".0/24", "").split(".").slice(0, 3);
  const sockets = os.networkInterfaces();
  for (const entries of Object.values(sockets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith(`${octets[0]}.${octets[1]}.${octets[2]}.`)) {
        return entry.address;
      }
    }
  }
  throw new Error("Could not detect a non-loopback local IP address");
}

export function getLocalSubnet(): string {
  return getAllLocalSubnets()[0];
}

export function hostsFromCidr(cidr: string): string[] {
  const [base, prefix] = cidr.split("/");
  const prefixLength = Number(prefix || 24);
  if (prefixLength !== 24) {
    throw new Error("Only /24 subnets are supported");
  }
  const octets = base.split(".").map(Number);
  const hosts: string[] = [];
  for (let i = 1; i < 255; i += 1) {
    hosts.push(`${octets[0]}.${octets[1]}.${octets[2]}.${i}`);
  }
  return hosts;
}
