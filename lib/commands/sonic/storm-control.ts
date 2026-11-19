/**
 * Click storm control (sonic-utilities config/main.py:834-915, 8378-8415 and
 * show/main.py:172-256, 474-508), on the same PORT_STORM_CONTROL rows KLISH
 * `storm-control` stores ("cp_storm_control" ports); enforced by
 * lib/protocols/storm-control.ts.
 *
 *   config interface storm-control add <port> broadcast|unknown-unicast|unknown-multicast <kbps 0-100000000>
 *   config interface storm-control del <port> <storm_type>
 *   show storm-control [interface <port>]        tabulate(..., tablefmt="grid")
 */
import { CommandContext, CommandResult, OutputLine, line, err } from "../types";
import { SonicCmd, SonicFeatureModule } from "./types";
import { cpList, cpRemove, cpUpsert } from "../sonic-cli/config-plane";
import { interfaceByName } from "../../models/device";

const TYPES = ["broadcast", "unknown-unicast", "unknown-multicast"];

/** storm_control_interface_validate (config/main.py:835-850). */
function validPort(ctx: CommandContext, port: string): string | null {
  if (!port.startsWith("Ethernet")) return `Storm-control is supported only on Ethernet interfaces. Not supported on ${port}`;
  if (!interfaceByName(ctx.device, port)) return `Interface name ${port} is invalid. Please enter a valid interface name`;
  return null;
}

function typeError(verb: string, t: string | undefined): OutputLine[] {
  return [
    err(`Usage: config interface storm-control ${verb} [OPTIONS] <port_name> <storm_type>${verb === "add" ? " <kbps_value>" : ""}`),
    err(t === undefined ? 'Error: Missing argument "<storm_type>".' : `Error: Invalid value for "<storm_type>": invalid choice: ${t}. (choose from broadcast, unknown-unicast, unknown-multicast)`),
  ];
}

const config: SonicCmd[] = [
  {
    path: ["interface", "storm-control", "add"],
    summary: "Configure storm-control",
    run(args, ctx): CommandResult {
      const [port, type, kbps] = args.filter((a) => !a.startsWith("-"));
      if (!port) return { output: [err("Usage: config interface storm-control add [OPTIONS] <port_name> <storm_type> <kbps_value>"), err('Error: Missing argument "<port_name>".')] };
      if (!type || !TYPES.includes(type)) return { output: typeError("add", type) };
      if (kbps === undefined || !/^\d+$/.test(kbps) || Number(kbps) > 100000000) {
        return { output: [err("Usage: config interface storm-control add [OPTIONS] <port_name> <storm_type> <kbps_value>"), err(kbps === undefined ? 'Error: Missing argument "<kbps_value>".' : `Error: Invalid value for "<kbps_value>": ${kbps} is not in the valid range of 0 to 100000000.`)] };
      }
      const bad = validPort(ctx, port);
      if (bad) return { output: [line(bad), err(`Error: Unable to add ${type} storm-control to interface ${port}`)] };
      cpUpsert(ctx.device, "storm_control", "ports", { id: `${port}|${type}`, iface: port, type, kbps: String(Number(kbps)) }, "id");
      return { output: [] };
    },
  },
  {
    path: ["interface", "storm-control", "del"],
    summary: "Remove storm-control",
    run(args, ctx): CommandResult {
      const [port, type] = args.filter((a) => !a.startsWith("-"));
      if (!port) return { output: [err("Usage: config interface storm-control del [OPTIONS] <port_name> <storm_type>"), err('Error: Missing argument "<port_name>".')] };
      if (!type || !TYPES.includes(type)) return { output: typeError("del", type) };
      const fail = err(`Error: Unable to delete ${type} storm-control from interface ${port}`);
      const bad = validPort(ctx, port);
      if (bad) return { output: [line(bad), fail] };
      const key = `${port}|${type}`;
      if (!cpList(ctx.device, "storm_control", "ports").some((e) => e.id === key)) return { output: [line(`${type} storm-control not enabled on interface ${port}`), fail] };
      cpRemove(ctx.device, "storm_control", "ports", "id", key);
      // storm_control_delete_entry ends with `return False` even after deleting the
      // entry (config/main.py:913), so the command always reports the failure.
      return { output: [fail] };
    },
  },
];

/** python-tabulate tablefmt="grid" (numeric columns right-aligned). */
function grid(headers: string[], rows: string[][]): OutputLine[] {
  const num = headers.map((_, c) => rows.length > 0 && rows.every((r) => /^-?\d+(\.\d+)?$/.test(r[c])));
  const w = headers.map((h, c) => Math.max(h.length + 2, ...rows.map((r) => r[c].length)));
  const cell = (v: string, c: number) => (num[c] ? v.padStart(w[c]) : v.padEnd(w[c]));
  const sep = (ch: string) => line("+" + w.map((n) => ch.repeat(n + 2)).join("+") + "+");
  const row = (r: string[]) => line("| " + r.map(cell).join(" | ") + " |");
  const out = [sep("-"), row(headers), sep("=")];
  rows.forEach((r, i) => out.push(row(r), ...(i < rows.length - 1 ? [sep("-")] : [])));
  out.push(sep("-"));
  return out;
}

const HEADER = ["Interface Name", "Storm Type", "Rate (kbps)"];

const show: SonicCmd[] = [
  {
    path: ["storm-control"],
    summary: "Show storm-control",
    run(args, ctx): CommandResult {
      const entries = cpList(ctx.device, "storm_control", "ports").map((e) => [String(e.iface), String(e.type), String(e.kbps)]);
      if (args[0] === "interface") {
        const port = args[1];
        if (!port) return { output: [err("Usage: show storm-control interface [OPTIONS] <interface>"), err('Error: Missing argument "<interface>".')] };
        if (!entries.length) return { output: [] };
        // display_storm_interface: fixed storm-type order.
        return { output: grid(HEADER, TYPES.flatMap((t) => entries.filter((e) => e[0] === port && e[1] === t))) };
      }
      if (!entries.length) return { output: [] }; // display_storm_all: empty table → no output
      entries.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }) || a[1].localeCompare(b[1]));
      return { output: grid(HEADER, entries) };
    },
  },
];

export const stormControlModule: SonicFeatureModule = { id: "storm-control", config, show };
