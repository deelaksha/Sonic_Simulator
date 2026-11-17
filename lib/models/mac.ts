/**
 * MAC address helpers. Addresses are stored uppercase, colon-separated.
 */

export const BROADCAST_MAC = "FF:FF:FF:FF:FF:FF";
export const NULL_MAC = "00:00:00:00:00:00";

/**
 * Standardize any common MAC representation (colon, hyphen, Cisco dot notation, or raw 12-hex)
 * into standard uppercase colon-separated format (e.g. "02:00:00:11:22:33").
 */
export function normalizeMac(mac: string): string {
  if (!mac) return "";
  const cleaned = mac.trim().replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (cleaned.length === 12) {
    return cleaned.match(/.{1,2}/g)!.join(":");
  }
  return mac.trim().toUpperCase();
}

/** Check if the string represents a valid 48-bit MAC address. */
export function isValidMac(mac: string): boolean {
  if (!mac || typeof mac !== "string") return false;
  const cleaned = mac.trim().replace(/[^a-fA-F0-9]/g, "");
  return cleaned.length === 12 && /^[0-9a-fA-F]{12}$/.test(cleaned);
}

export function isBroadcast(mac: string): boolean {
  return normalizeMac(mac) === BROADCAST_MAC;
}

/** IEEE multicast bit is the least-significant bit of the first octet. */
export function isMulticast(mac: string): boolean {
  const norm = normalizeMac(mac);
  const parts = norm.split(":");
  if (parts.length < 1 || !parts[0]) return false;
  const first = parseInt(parts[0], 16);
  if (Number.isNaN(first)) return false;
  return (first & 0x01) === 1;
}

/** Valid unicast MAC address (usable for interface hardware address assignment). */
export function isUnicast(mac: string): boolean {
  const norm = normalizeMac(mac);
  return isValidMac(norm) && !isBroadcast(norm) && !isMulticast(norm) && norm !== NULL_MAC;
}

const hex = (x: number) => x.toString(16).padStart(2, "0").toUpperCase();

/**
 * Deterministically generate a locally-administered unicast MAC from a seed.
 * Uses the 02:00:00 prefix (locally administered, unicast) so generated
 * addresses never collide with real hardware OUIs.
 */
export function generateMac(seed: number): string {
  const n = seed >>> 0;
  return `02:00:00:${hex((n >> 16) & 0xff)}:${hex((n >> 8) & 0xff)}:${hex(n & 0xff)}`;
}
