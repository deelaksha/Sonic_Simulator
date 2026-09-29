/**
 * VRRP SONiC feature module. Commands mutate per-device feature state
 * (features.vrrp.instances) — the SAME store the packet-plane reads
 * (lib/protocols/vrrp.ts). `show vrrp` now renders the LIVE Master/Backup state
 * from that engine election (priority + interface liveness), so it reflects
 * failover the instant a master's interface goes down. The engine (ARP for the
 * VIP with the virtual MAC, ping-to-VIP, forwarding to the vMAC, gratuitous ARP
 * on failover) is implemented — this is no longer config-plane only.
 *
 * vrrp.txt drives this feature from klish `interface <if>` context. The bare
 * `vrrp <vrid>` creates the router and the shared attributes hang off it; here
 * those forms are expressed as SONiC click under path ["vrrp", ...]:
 *
 *   config vrrp add <iface> <vrid>              <- interface <if> / vrrp <vrid>
 *   config vrrp vip <iface> <vrid> <ip>         <- vrrp <vrid> ip <ip>
 *   config vrrp priority <iface> <vrid> <n>     <- vrrp <vrid> priority <n>
 *   config vrrp version <iface> <vrid> <2|3>    <- vrrp <vrid> version <n>
 *   config vrrp preempt <iface> <vrid> <en|dis> <- [no] vrrp <vrid> preempt
 *   config vrrp del <iface> <vrid>              <- no vrrp <vrid>
 *   show vrrp                                   <- show vrrp / show vrrp summary
 *
 * Ranges/defaults are sourced from vrrp.txt: vrid 1..255 (key); priority 1..254
 * default 100; version 2..3 default 3; preempt default enabled. VIP must be a
 * valid IPv4 address. Deleting a non-existent instance is a silent no-op
 * (vrrp.txt Section 7: "no vrrp 200 ... SUCCEEDS silently").
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { interfaceByName } from "../../models/device";
import { isValidIpv4 } from "../../models/ip";
import { vrrpRole } from "../../protocols/vrrp";

interface VrrpInstance {
  iface: string;
  vrid: number;
  vip?: string;
  priority?: number;
  preempt?: boolean;
  version?: number;
}

interface VrrpState {
  instances: VrrpInstance[];
}

// Sourced from vrrp.txt "RANGES / DEFAULTS".
const VRID = { min: 1, max: 255 };
const PRIORITY = { min: 1, max: 254, default: 100 };
const VERSION = { min: 2, max: 3, default: 3 };
const PREEMPT_DEFAULT = true;

function state(ctx: CommandContext): VrrpState {
  return featureState<VrrpState>(ctx.device, "vrrp", () => ({ instances: [] as VrrpInstance[] }));
}

/** Integer token or null (rejects blanks and non-integers like "10.5"). */
function parseInt10(tok: string | undefined): number | null {
  if (tok === undefined || tok.trim() === "") return null;
  const n = Number(tok);
  return Number.isInteger(n) ? n : null;
}

/** Validate a VRID token against the 1..255 range; error line or the number. */
function parseVrid(tok: string | undefined): { vrid: number } | { error: OutputLine } {
  const n = parseInt10(tok);
  if (n === null || n < VRID.min || n > VRID.max) {
    return { error: err(`VRID must be ${VRID.min}-${VRID.max} (got '${tok}')`) };
  }
  return { vrid: n };
}

function findInstance(st: VrrpState, iface: string, vrid: number): VrrpInstance | undefined {
  return st.instances.find((i) => i.iface === iface && i.vrid === vrid);
}

/** "enable"/"disable" (and enabled/disabled/on/off) -> boolean, else null. */
function parsePreempt(tok: string | undefined): boolean | null {
  const t = (tok ?? "").toLowerCase();
  if (t === "enable" || t === "enabled" || t === "on") return true;
  if (t === "disable" || t === "disabled" || t === "off") return false;
  return null;
}

const config: SonicCmd[] = [
  {
    path: ["vrrp", "add"],
    summary: "Create a VRRP instance on an interface (config vrrp add <iface> <vrid>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err("Usage: config vrrp add <iface> <vrid>")] };
      if (!interfaceByName(ctx.device, iface)) return { output: [err(`config vrrp add: interface ${iface} not found`)] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const st = state(ctx);
      if (findInstance(st, iface, v.vrid)) {
        return { output: [muted(`VRRP ${v.vrid} already configured on ${iface} (no-op)`)] };
      }
      st.instances.push({ iface, vrid: v.vrid });
      return { output: [muted(`VRRP ${v.vrid} created on ${iface}`)] };
    },
  },
  {
    path: ["vrrp", "vip"],
    summary: "Set the virtual IP of a VRRP instance (config vrrp vip <iface> <vrid> <ip>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err("Usage: config vrrp vip <iface> <vrid> <ip>")] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const ip = pos[2];
      if (!ip || !isValidIpv4(ip)) return { output: [err(`config vrrp vip: invalid IPv4 address '${ip ?? ""}'`)] };
      const inst = findInstance(state(ctx), iface, v.vrid);
      if (!inst) return { output: [err(`config vrrp vip: VRRP ${v.vrid} not configured on ${iface}`)] };
      inst.vip = ip;
      return { output: [muted(`VRRP ${v.vrid} on ${iface} virtual IP set to ${ip}`)] };
    },
  },
  {
    path: ["vrrp", "priority"],
    summary: "Set the priority of a VRRP instance (config vrrp priority <iface> <vrid> <1-254>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err("Usage: config vrrp priority <iface> <vrid> <1-254>")] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const n = parseInt10(pos[2]);
      if (n === null || n < PRIORITY.min || n > PRIORITY.max) {
        return { output: [err(`config vrrp priority: priority must be ${PRIORITY.min}-${PRIORITY.max} (got '${pos[2] ?? ""}')`)] };
      }
      const inst = findInstance(state(ctx), iface, v.vrid);
      if (!inst) return { output: [err(`config vrrp priority: VRRP ${v.vrid} not configured on ${iface}`)] };
      inst.priority = n;
      return { output: [muted(`VRRP ${v.vrid} on ${iface} priority set to ${n}`)] };
    },
  },
  {
    path: ["vrrp", "version"],
    summary: "Set the protocol version of a VRRP instance (config vrrp version <iface> <vrid> <2|3>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err("Usage: config vrrp version <iface> <vrid> <2|3>")] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const n = parseInt10(pos[2]);
      if (n === null || n < VERSION.min || n > VERSION.max) {
        return { output: [err(`config vrrp version: version must be ${VERSION.min}-${VERSION.max} (got '${pos[2] ?? ""}')`)] };
      }
      const inst = findInstance(state(ctx), iface, v.vrid);
      if (!inst) return { output: [err(`config vrrp version: VRRP ${v.vrid} not configured on ${iface}`)] };
      inst.version = n;
      return { output: [muted(`VRRP ${v.vrid} on ${iface} version set to ${n}`)] };
    },
  },
  {
    path: ["vrrp", "preempt"],
    summary: "Enable/disable preemption on a VRRP instance (config vrrp preempt <iface> <vrid> <enable|disable>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err("Usage: config vrrp preempt <iface> <vrid> <enable|disable>")] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const on = parsePreempt(pos[2]);
      if (on === null) return { output: [err(`config vrrp preempt: expected enable or disable (got '${pos[2] ?? ""}')`)] };
      const inst = findInstance(state(ctx), iface, v.vrid);
      if (!inst) return { output: [err(`config vrrp preempt: VRRP ${v.vrid} not configured on ${iface}`)] };
      inst.preempt = on;
      return { output: [muted(`VRRP ${v.vrid} on ${iface} preempt ${on ? "enabled" : "disabled"}`)] };
    },
  },
  {
    path: ["vrrp", "del"],
    summary: "Delete a VRRP instance (config vrrp del <iface> <vrid>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err("Usage: config vrrp del <iface> <vrid>")] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const st = state(ctx);
      const before = st.instances.length;
      st.instances = st.instances.filter((i) => !(i.iface === iface && i.vrid === v.vrid));
      // Deleting a non-existent instance is a silent no-op (vrrp.txt Section 7).
      return {
        output: [muted(st.instances.length < before ? `VRRP ${v.vrid} deleted from ${iface}` : `VRRP ${v.vrid} not configured on ${iface} (no-op)`)],
      };
    },
  },
];

function renderInstances(ctx: CommandContext): OutputLine[] {
  const instances = [...(peekFeatureState<VrrpState>(ctx.device, "vrrp")?.instances ?? [])].sort(
    (a, b) => a.iface.localeCompare(b.iface) || a.vrid - b.vrid,
  );
  if (instances.length === 0) return [muted("No VRRP instances configured")];
  const out: OutputLine[] = [
    line(`${"Interface".padEnd(14)}${"VRID".padEnd(6)}${"Virtual IP".padEnd(18)}${"State".padEnd(9)}${"Priority".padEnd(10)}${"Preempt".padEnd(10)}Version`),
  ];
  for (const i of instances) {
    // Live role from the packet-plane election (priority + interface liveness).
    const role = i.vip ? vrrpRole(ctx.network, ctx.device, i.vip) : "Init";
    out.push(
      line(
        `${i.iface.padEnd(14)}${String(i.vrid).padEnd(6)}${(i.vip ?? "-").padEnd(18)}${role.padEnd(9)}${String(i.priority ?? PRIORITY.default).padEnd(10)}${((i.preempt ?? PREEMPT_DEFAULT) ? "enabled" : "disabled").padEnd(10)}v${i.version ?? VERSION.default}`,
      ),
    );
  }
  return out;
}

const show: SonicCmd[] = [
  { path: ["vrrp"], summary: "Show configured VRRP instances", run: (_a, ctx) => ({ output: renderInstances(ctx) }) },
];

export const vrrpModule: SonicFeatureModule = { id: "vrrp", config, show };
