/**
 * IPv4 address math. Pure functions, no side effects.
 * Everything the routing / subnetting logic needs lives here so there is a
 * single, testable source of truth for address arithmetic.
 */

export interface Ipv4Addr {
  address: string; // e.g. "192.168.1.10"
  prefix: number; // e.g. 24
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}

export function isValidPrefix(prefix: number): boolean {
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

/** A DNS hostname (e.g. time.google.com): dot-separated labels of [a-z0-9-]. */
export function isValidHostname(name: string): boolean {
  const n = name.trim();
  if (n.length === 0 || n.length > 253 || isValidIpv4(n)) return false;
  if (!/[a-zA-Z]/.test(n)) return false; // all-numeric dotted strings are IP typos, not hostnames
  return n.split(".").every((label) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

export function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function prefixToMaskInt(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function prefixToMask(prefix: number): string {
  return intToIp(prefixToMaskInt(prefix));
}

export function networkInt(ip: string, prefix: number): number {
  return (ipToInt(ip) & prefixToMaskInt(prefix)) >>> 0;
}

export function networkAddress(ip: string, prefix: number): string {
  return intToIp(networkInt(ip, prefix));
}

export function broadcastAddress(ip: string, prefix: number): string {
  const bcast = (networkInt(ip, prefix) | (~prefixToMaskInt(prefix) >>> 0)) >>> 0;
  return intToIp(bcast);
}

/** True when both hosts sit in the same IPv4 subnet for a given prefix. */
export function sameSubnet(a: string, b: string, prefix: number): boolean {
  return networkInt(a, prefix) === networkInt(b, prefix);
}

/** True when `ip` falls inside the CIDR block network/prefix. */
export function cidrContains(network: string, prefix: number, ip: string): boolean {
  return ((ipToInt(ip) & prefixToMaskInt(prefix)) >>> 0) === networkInt(network, prefix);
}

export function formatCidr(addr: Ipv4Addr): string {
  return `${addr.address}/${addr.prefix}`;
}
