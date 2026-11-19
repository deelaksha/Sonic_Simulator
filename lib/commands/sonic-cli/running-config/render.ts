/**
 * Composes `show running-configuration [<feature>]` from the registered sections.
 *
 * Full form = sonic_cli_show_config.py show_all_config: "!", "Current
 * configuration:", "!", every section's blocks in `order` (the interface
 * section merges every feature's per-interface lines), "!", "end".
 *
 * Deviation from the source order (kept small and replay-driven): VRF and VLAN
 * definitions are printed before the interface blocks (the source prints them
 * after), and PortChannel blocks before Ethernet blocks, so the output replays
 * line by line (`ip vrf forwarding`, `switchport access Vlan`, `channel-group`
 * need the VRF/VLAN/LAG to exist first).
 */
import { Device } from "../../../models/device";
import { NetInterface } from "../../../models/interface";
import { lagEntry } from "../../sonic/lacp";
import { RC_SECTIONS, RcSection, natCompare } from "./registry";

/** Interfaces in output order: PortChannel first, then natsort; Management (eth0) last. */
export function rcInterfaces(dev: Device): NetInterface[] {
  const rank = (i: NetInterface) => (i.management ? 2 : i.name.startsWith("PortChannel") ? 0 : 1);
  return [...dev.interfaces].sort((a, b) => rank(a) - rank(b) || natCompare(a.name, b.name));
}

/** KLISH name of an interface (eth0 is Management0 in KLISH). */
export const klishIfName = (i: NetInterface) => (i.management ? "Management0" : i.name);

const sorted = () => [...RC_SECTIONS].sort((a, b) => a.order - b.order);
const ifSections = () => RC_SECTIONS.filter((s) => s.iface).sort((a, b) => (a.ifOrder ?? 500) - (b.ifOrder ?? 500));

/** The `interface <name>` block for one interface from the given sections (empty when nothing to print). */
export function interfaceBlock(dev: Device, i: NetInterface, sections: RcSection[] = ifSections()): string[] {
  const body = sections.flatMap((s) => s.iface!(dev, i.name));
  if (!body.length) return [];
  // PortChannel header carries the mode (show_interface_running_config.j2:491).
  const pc = i.name.startsWith("PortChannel") ? lagEntry(dev, i.name) : undefined;
  return [`interface ${klishIfName(i)}${pc ? ` mode ${pc.static ? "on" : "active"}` : ""}`, ...body];
}

/** Every interface block (optionally only `only` / one type prefix). */
export function interfaceBlocks(dev: Device, sections?: RcSection[], filter?: (i: NetInterface) => boolean): string[][] {
  return rcInterfaces(dev)
    .filter((i) => !filter || filter(i))
    .map((i) => interfaceBlock(dev, i, sections))
    .filter((b) => b.length);
}

/** Join blocks with "!" separators (each block starts after a "!"). */
export function joinBlocks(blocks: string[][]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (!b.length) continue;
    if (out[out.length - 1] !== "!") out.push("!");
    out.push(...b);
  }
  return out;
}

export function renderAll(dev: Device): string[] {
  const blocks: string[][] = [];
  for (const s of sorted()) {
    if (s.id === "interface") blocks.push(...interfaceBlocks(dev));
    else if (s.global) blocks.push(...s.global(dev));
  }
  return ["!", "Current configuration:", ...joinBlocks(blocks), "!", "end"];
}

/** One feature: its global blocks + the interface blocks carrying its per-interface lines. */
export function renderSection(dev: Device, s: RcSection): string[] {
  const blocks = [...(s.global?.(dev) ?? []), ...(s.iface ? interfaceBlocks(dev, [s]) : [])];
  return joinBlocks(blocks);
}

/** Section serving `show running-configuration <args>` (longest keyword match), if any. */
export function sectionFor(args: string[]): { section: RcSection; rest: string[] } | undefined {
  let best: { section: RcSection; rest: string[]; n: number } | undefined;
  for (const s of RC_SECTIONS) {
    for (const kw of s.keywords ?? []) {
      if (kw.length > args.length || !kw.every((k, i) => args[i] === k)) continue;
      if (!best || kw.length > best.n) best = { section: s, rest: args.slice(kw.length), n: kw.length };
    }
  }
  return best && { section: best.section, rest: best.rest };
}
