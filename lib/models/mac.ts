/**
 * MAC address helpers. Addresses are stored uppercase, colon-separated.
 */

export const BROADCAST_MAC = "FF:FF:FF:FF:FF:FF";
export const NULL_MAC = "00:00:00:00:00:00";

export function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase();
}

export function isBroadcast(mac: string): boolean {
  return normalizeMac(mac) === BROADCAST_MAC;
}

/** IEEE multicast bit is the least-significant bit of the first octet. */
export function isMulticast(mac: string): boolean {
  const first = parseInt(mac.split(":")[0], 16);
  return (first & 0x01) === 1;
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
