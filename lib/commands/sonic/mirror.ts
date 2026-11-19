/**
 * Click mirror sessions (sonic-utilities config/main.py:3066-3240 `config
 * mirror_session …`, acl_loader/main.py:978-1009 `show mirror_session`).
 * Rows go into the same config-plane store as KLISH `mirror-session`
 * ("cp_mirror" sessions); lib/protocols/mirror.ts does the mirroring.
 *
 *   config mirror_session span add <name> <dst_port> [src_port] [direction] [queue] [--policer P]
 *   config mirror_session erspan add <name> <src_ip> <dst_ip> <dscp> <ttl> [gre_type] [queue] [src_port] [direction] [--policer P]
 *   config mirror_session add <name> <src_ip> <dst_ip> <dscp> <ttl> [gre_type] [queue]   (legacy ERSPAN)
 *   config mirror_session remove <name>
 *   show mirror_session [name]
 *
 * gather_session_info (:3114-3133): a source port without a direction means
 * "both"; validate_gre_type (:1371-1385) stores the GRE type as an integer.
 */
import { CommandContext, CommandResult, OutputLine, line, err } from "../types";
import { SonicCmd, SonicFeatureModule } from "./types";
import { cpRemove, cpUpsert } from "../sonic-cli/config-plane";
import { findInterface, interfaceByName } from "../../models/device";
import { isValidIpv4 } from "../../models/ip";
import { longestPrefixMatch } from "../../models/route";
import { MirrorSession, mirrorSessions, sessionStatus } from "../../protocols/mirror";
import { tabulate } from "./snmp";

/** Split positionals from `--policer X`. */
function parse(args: string[]): { pos: string[]; policer?: string } {
  const pos: string[] = [];
  let policer: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--policer") policer = args[++i];
    else pos.push(args[i]);
  }
  return { pos, policer };
}

const intIn = (v: string, lo: number, hi: number) => /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi;

/** validate_mirror_session_config (config/main.py:1200-1242), the checks that apply to the simulator. */
function validate(ctx: CommandContext, name: string, dst: string | undefined, src: string | undefined, direction: string | undefined): string | null {
  if (mirrorSessions(ctx.device).some((s) => s.name === name)) return `Error: ${name} already exists`;
  if (dst) {
    const d = interfaceByName(ctx.device, dst);
    if (!d || d.management) return `Error: Destination Interface ${dst} is invalid`;
    if (/^PortChannel/.test(dst)) return `Error: Destination Interface ${dst} is not supported`;
    if (d.ipv4.length > 0) return `Error: Destination Interface ${dst} is a L3 interface`;
  }
  for (const p of src ? src.split(",") : []) {
    if (!interfaceByName(ctx.device, p)) return `Error: Source Interface ${p} is invalid`;
    if (dst && dst === p) return "Error: Destination Interface cant be same as Source Interface";
  }
  if (direction && !["rx", "tx", "both"].includes(direction)) return `Error: Direction ${direction} is invalid`;
  return null;
}

function store(ctx: CommandContext, s: MirrorSession, policer?: string, queue?: string): void {
  if (policer) s.policer = policer;
  if (queue !== undefined) s.queue = queue;
  if (s.src) s.direction = (s.direction || "both").toLowerCase();
  cpUpsert(ctx.device, "mirror", "sessions", s as unknown as Record<string, unknown>, "name");
}

function addErspan(args: string[], ctx: CommandContext, legacy: boolean): CommandResult {
  const { pos, policer } = parse(args);
  const [name, srcIp, dstIp, dscp, ttl, gre, queue, srcPort, direction] = pos;
  const usage = `Usage: config mirror_session ${legacy ? "" : "erspan "}add [OPTIONS] <session_name> <src_ip> <dst_ip> <dscp> <ttl> [gre_type] [queue]${legacy ? "" : " [src_port] [direction]"}`;
  if (!name || !srcIp || !dstIp || dscp === undefined || ttl === undefined) return { output: [err(usage), err(`Error: Missing argument "${!name ? "<session_name>" : !srcIp ? "<src_ip>" : !dstIp ? "<dst_ip>" : dscp === undefined ? "<dscp>" : "<ttl>"}".`)] };
  if (legacy && pos.length > 7) return { output: [err(usage), err(`Error: Got unexpected extra argument (${pos[7]})`)] };
  for (const ip of [srcIp, dstIp]) if (!isValidIpv4(ip)) return { output: [err(usage), err(`Error: Invalid value: ${ip} is not a valid IPv4 address`)] };
  if (!intIn(dscp, 0, 63)) return { output: [err(usage), err(`Error: Invalid value for "<dscp>": ${dscp} is not in the valid range of 0 to 63.`)] };
  if (!intIn(ttl, 0, 255)) return { output: [err(usage), err(`Error: Invalid value for "<ttl>": ${ttl} is not in the valid range of 0 to 255.`)] };
  let greType: string | undefined;
  if (gre !== undefined) {
    const v = /^0x[0-9a-f]+$/i.test(gre) ? parseInt(gre, 16) : /^\d+$/.test(gre) ? Number(gre) : NaN;
    if (!(v >= 0 && v <= 65535)) return { output: [err(usage), err(`Error: ${gre} is not a valid GRE type`)] };
    greType = String(v);
  }
  if (queue !== undefined && !intIn(queue, 0, 255)) return { output: [err(usage), err(`Error: Invalid value for "[queue]": ${queue} is not in the valid range of 0 to 255.`)] };
  const bad = validate(ctx, name, undefined, srcPort, direction);
  if (bad) return { output: [err(bad)] };
  store(ctx, { name, type: "erspan", src_ip: srcIp, dst_ip: dstIp, dscp, ttl, ...(greType !== undefined ? { gre: greType } : {}), ...(srcPort ? { src: srcPort, direction } : {}) }, policer, queue);
  return { output: [] };
}

const config: SonicCmd[] = [
  {
    path: ["mirror_session", "span", "add"],
    summary: "Add SPAN mirror session",
    run(args, ctx): CommandResult {
      const { pos, policer } = parse(args);
      const [name, dst, src, direction, queue] = pos;
      const usage = "Usage: config mirror_session span add [OPTIONS] <session_name> <dst_port> [src_port] [direction] [queue]";
      if (!name || !dst) return { output: [err(usage), err(`Error: Missing argument "${!name ? "<session_name>" : "<dst_port>"}".`)] };
      if (queue !== undefined && !intIn(queue, 0, 255)) return { output: [err(usage), err(`Error: Invalid value for "[queue]": ${queue} is not in the valid range of 0 to 255.`)] };
      const bad = validate(ctx, name, dst, src, direction);
      if (bad) return { output: [err(bad)] };
      store(ctx, { name, type: "span", dst, ...(src ? { src, direction } : {}) }, policer, queue);
      return { output: [] };
    },
  },
  { path: ["mirror_session", "erspan", "add"], summary: "Add ERSPAN mirror session", run: (a, ctx) => addErspan(a, ctx, false) },
  { path: ["mirror_session", "add"], summary: "Add ERSPAN mirror session (legacy)", run: (a, ctx) => addErspan(a, ctx, true) },
  {
    path: ["mirror_session", "remove"],
    summary: "Delete mirror session",
    run(args, ctx): CommandResult {
      const name = args[0];
      if (!name) return { output: [err("Usage: config mirror_session remove [OPTIONS] <session_name>"), err('Error: Missing argument "<session_name>".')] };
      cpRemove(ctx.device, "mirror", "sessions", "name", name);
      return { output: [] };
    },
  },
];

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** acl_loader show_session: ERSPAN then SPAN tables (tabulate "simple"), natsorted rows. */
function showSessions(ctx: CommandContext, only?: string): OutputLine[] {
  const dev = ctx.device;
  const list = mirrorSessions(dev).filter((s) => !only || s.name === only);
  const erspan: string[][] = [];
  const span: string[][] = [];
  for (const s of list) {
    const status = sessionStatus(dev, s);
    if (s.type === "erspan") {
      const r = status === "active" ? longestPrefixMatch(dev.routingTable, s.dst_ip!) : undefined;
      const monitor = r ? findInterface(dev, r.route.interfaceId)?.name ?? "" : "";
      erspan.push([s.name, status, s.src_ip ?? "", s.dst_ip ?? "", s.gre ?? "", s.dscp ?? "", s.ttl ?? "", s.queue ?? "", s.policer ?? "", monitor, s.src ?? "", (s.direction ?? "").toLowerCase()]);
    } else {
      span.push([s.name, status, s.dst ?? "", s.src ?? "", (s.direction ?? "").toLowerCase(), s.queue ?? "", s.policer ?? ""]);
    }
  }
  erspan.sort((a, b) => natural(a[0], b[0]));
  span.sort((a, b) => natural(a[0], b[0]));
  return [
    line("ERSPAN Sessions"),
    ...tabulate(erspan, ["Name", "Status", "SRC IP", "DST IP", "GRE", "DSCP", "TTL", "Queue", "Policer", "Monitor Port", "SRC Port", "Direction"]),
    line(""),
    line("SPAN Sessions"),
    ...tabulate(span, ["Name", "Status", "DST Port", "SRC Port", "Direction", "Queue", "Policer"]),
  ];
}

const show: SonicCmd[] = [
  { path: ["mirror_session"], summary: "Show existing everflow sessions", run: (args, ctx) => ({ output: showSessions(ctx, args[0]) }) },
];

export const mirrorModule: SonicFeatureModule = { id: "mirror", config, show };
