/**
 * Small helpers shared by the KLISH `show` renderers in this directory that
 * reproduce sonic-mgmt-framework Jinja templates (render-templates/*.j2,
 * rendered with trim_blocks/lstrip_blocks — scripts/render_cli.py:212-219).
 */
import { OutputLine, err, line } from "../../types";

/** Python str.center(width): CPython puts the extra pad char on the left when (pad & width & 1). */
export function pyCenter(s: string, width: number): string {
  const pad = width - s.length;
  if (pad <= 0) return s;
  const left = Math.floor(pad / 2) + (pad & width & 1);
  return " ".repeat(left) + s + " ".repeat(pad - left);
}

/**
 * KLISH writes interfaces as `Ethernet 0` / `PortChannel 1` / `Vlan 10` (two tokens)
 * or `Ethernet0`. Returns the joined name and how many tokens it consumed.
 */
export function ifArg(args: string[], i: number): { name: string; used: number } | undefined {
  const a = args[i];
  if (!a) return undefined;
  if (/^(Ethernet|PortChannel|Vlan|Loopback|Management|Eth)$/i.test(a) && args[i + 1] !== undefined && /^[\d/.:]+$/.test(args[i + 1])) {
    return { name: canonIf(a) + args[i + 1], used: 2 };
  }
  return { name: a, used: 1 };
}

function canonIf(t: string): string {
  const m: Record<string, string> = { ethernet: "Ethernet", portchannel: "PortChannel", vlan: "Vlan", loopback: "Loopback", management: "Management", eth: "Eth" };
  return m[t.toLowerCase()] ?? t;
}

/** klish answer for a missing mandatory PARAM. */
export const incomplete = (): { output: OutputLine[] } => ({ output: [err("% Error: Incomplete command.")] });

/** A COMMAND with no ACTION (a pure keyword container, e.g. bare `show qos`): klish runs nothing and prints nothing. */
export const noAction = (): { output: OutputLine[] } => ({ output: [] });

export const lines = (rows: string[]): { output: OutputLine[] } => ({ output: rows.map((r) => line(r)) });

/** Natural sort for interface names (Ethernet2 < Ethernet10). */
export const natCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
