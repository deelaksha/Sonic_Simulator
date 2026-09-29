/**
 * IPv6 address math (128-bit, via BigInt). Pure + testable — the v6 counterpart
 * to ip.ts. Supports `::` compression on both parse and format.
 */

export interface Ipv6Addr {
  address: string; // canonical compressed lowercase, e.g. "2001:db8::1"
  prefix: number; // 0..128
}

const MAX128 = (1n << 128n) - 1n;

export function isValidPrefix6(prefix: number): boolean {
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 128;
}

/** Parse an IPv6 string to a BigInt, or null if malformed. Handles `::`. */
export function parseIpv6(input: string): bigint | null {
  const str = input.trim().toLowerCase();
  if (str.length === 0 || str === "::") return str === "::" ? 0n : null;

  const halves = str.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const parts = s.split(":");
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };

  let groups: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]);
    const right = parseGroups(halves[1]);
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // `::` must stand for at least one zero group
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    const g = parseGroups(str);
    if (!g || g.length !== 8) return null;
    groups = g;
  }

  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return n;
}

/** Format a BigInt as a canonical compressed IPv6 string. */
export function formatIpv6(n: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn));

  // Find the longest run of zero groups (length >= 2) to compress.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

export function isValidIpv6(input: string): boolean {
  return parseIpv6(input) !== null;
}

export function normalizeIpv6(input: string): string {
  const n = parseIpv6(input);
  return n === null ? input : formatIpv6(n);
}

export function prefixMask6(prefix: number): bigint {
  if (prefix <= 0) return 0n;
  if (prefix >= 128) return MAX128;
  return (MAX128 << BigInt(128 - prefix)) & MAX128;
}

export function network6(addr: string, prefix: number): bigint {
  const n = parseIpv6(addr);
  if (n === null) return 0n;
  return n & prefixMask6(prefix);
}

export function networkAddress6(addr: string, prefix: number): string {
  return formatIpv6(network6(addr, prefix));
}

export function sameSubnet6(a: string, b: string, prefix: number): boolean {
  const na = parseIpv6(a);
  const nb = parseIpv6(b);
  if (na === null || nb === null) return false;
  const mask = prefixMask6(prefix);
  return (na & mask) === (nb & mask);
}

/** True when `ip` falls inside network/prefix. */
export function contains6(networkStr: string, prefix: number, ip: string): boolean {
  const nip = parseIpv6(ip);
  if (nip === null) return false;
  return (nip & prefixMask6(prefix)) === network6(networkStr, prefix);
}

/** fe80::/10 link-local. */
export function isLinkLocal6(addr: string): boolean {
  const n = parseIpv6(addr);
  if (n === null) return false;
  return (n >> 118n) === 0x3fan; // top 10 bits == 1111111010
}

export function formatCidr6(addr: Ipv6Addr): string {
  return `${addr.address}/${addr.prefix}`;
}
