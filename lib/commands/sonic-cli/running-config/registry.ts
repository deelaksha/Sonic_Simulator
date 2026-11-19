/**
 * KLISH `show running-configuration` section registry.
 *
 * The real command (sonic-mgmt-framework CLI/actioner/sonic_cli_show_config.py
 * show_all_config) prints one section per feature in a fixed order; per-interface
 * config of every feature (OSPF, VRRP, LLDP, ACL, sFlow, link tracking, QoS, ...)
 * is merged into ONE `interface <name>` block (renderer/templates/
 * show_interface_running_config.j2). Each feature registers here:
 *
 *   order     where its global blocks go in the full output
 *   global()  its global blocks (each block = lines; a "!" separates blocks)
 *   iface()   its lines inside `interface <name>` (one-space indented)
 *   ifOrder   where those lines go inside the interface block
 *   keywords  `show running-configuration <kw..>` forms that render just it
 *
 * Renderers read the feature's stored config only; they never invent defaults.
 */
import { Device } from "../../../models/device";

export interface RcSection {
  id: string;
  order: number;
  global?(dev: Device): string[][];
  iface?(dev: Device, ifname: string): string[];
  ifOrder?: number;
  /** `show running-configuration <keywords...>` (lower-case tokens) served by this section alone. */
  keywords?: string[][];
}

export const RC_SECTIONS: RcSection[] = [];

export function registerRcSection(s: RcSection): void {
  const i = RC_SECTIONS.findIndex((x) => x.id === s.id);
  if (i >= 0) RC_SECTIONS[i] = s;
  else RC_SECTIONS.push(s);
}

// --- small shared helpers ---------------------------------------------------

/** "Ethernet 0"/"Ethernet0" ordering helper (natsort, as natsorted() in the actioners). */
export function natCompare(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const [x, y] = [ta[i], tb[i]];
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}

/** "10,20-22,30" (sonic_cli_vlan.py _format_trunk_vlan_ranges). */
export function vlanRanges(ids: number[]): string {
  const v = [...new Set(ids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < v.length; ) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    out.push(i === j ? String(v[i]) : `${v[i]}-${v[j]}`);
    i = j + 1;
  }
  return out.join(",");
}

/** description values with spaces are quoted (show_interface_running_config.j2:40-44). */
export const quoteIfSpace = (s: string) => (s.includes(" ") ? `"${s}"` : s);

/** Read a value only when it was set (not undefined/null/""). */
export const isSet = (v: unknown) => v !== undefined && v !== null && v !== "";
