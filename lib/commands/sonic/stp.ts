/**
 * Spanning Tree (STP) Click CLI commands.
 */
import { SonicFeatureModule, SonicCmd } from "./types";
import { line, err, muted, OutputLine, CommandContext } from "../types";
import { Device, isSwitch } from "../../models/device";
import { cpSet, cpGet, cpList } from "../sonic-cli/config-plane";
import { getStpBridgeOper, stpCounters, StpBridgeOper } from "../../protocols/stp-daemon";
import { listVlans, vlanMembers } from "../../models/vlan-ops";
import { natCompare } from "./counters";
import { clickUsageError } from "./types";

// ---------------------------------------------------------------------------
// Click `show spanning-tree vlan|bpdu_guard|root_guard|statistics` (sonic-utilities
// show/stp.py). APPL_DB STP_VLAN_TABLE / STP_VLAN_PORT_TABLE rows come from the
// running STP instance (lib/protocols/stp-daemon.ts) — one per STP-enabled VLAN,
// bridge ids in hex with the VLAN id added to the priority (PVST sys-id-ext);
// STP_PORT rows from the stored per-interface spanning-tree config.
// ---------------------------------------------------------------------------

const fmt = (v: (string | number)[], w: number[]) => v.map((x, k) => (k < w.length ? String(x).padEnd(w[k]) : String(x))).join("");
const W_BRIDGE = [17, 7, 7, 7, 6, 13];
const W_ROOT = [17, 10, 18, 19, 4, 4];
const W_PORT = [17, 5, 10, 5, 7, 14, 12, 17];

/** "<prio>.<mac>" → 16-hex APPL_DB bridge id with the VLAN id in the priority. */
function hexId(id: string, vid: number): string {
  const [prio, mac] = id.split(".");
  return (Number(prio) + vid).toString(16).padStart(4, "0") + mac.replace(/:/g, "").toLowerCase();
}

/** STP_VLAN_TABLE keys: configured VLANs not disabled with `no spanning-tree vlan`. */
function stpVlans(d: Device): number[] {
  const off = new Set(cpList(d, "stp", "vlans").filter((v) => v.disabled === true).map((v) => Number(v.vlan)));
  return listVlans(d).map((v) => v.id).filter((v) => !off.has(v)).sort((a, b) => a - b);
}

const intfCfg = (d: Device, ifname: string) => cpList(d, "stp", "interfaces").find((r) => r.ifname === ifname) ?? {};

/** VLAN member ports that have an STP port (STP_VLAN_PORT_TABLE keys), show/stp.py ordering. */
function vlanPorts(d: Device, oper: StpBridgeOper, vid: number) {
  const byName = new Map(Object.values(oper.ports).map((p) => [p.interfaceName, p]));
  const names = vlanMembers(d, vid).map((m) => m.port).filter((n) => byName.has(n));
  // eth_list / po_list hold the numeric suffixes as strings and are sorted as strings
  const eth = names.filter((n) => n.startsWith("Ethernet")).map((n) => n.slice(8)).sort();
  const po = names.filter((n) => n.startsWith("PortChannel")).map((n) => n.slice(11)).sort();
  return [...eth.map((n) => `Ethernet${n}`), ...po.map((n) => `PortChannel${n}`)].map((n) => byName.get(n)!);
}

function stpMode(d: Device): string {
  const m = (cpGet(d, "stp")?.mode as string | undefined) ?? "rpvst";
  return m === "pvst" ? "PVST" : m === "mst" ? "MST" : "RPVST";
}

function vlanHeader(ctx: CommandContext, oper: StpBridgeOper, vid: number, inst: number): string[] {
  const d = ctx.device;
  const rp = oper.rootPortId ? oper.ports[oper.rootPortId] : undefined;
  const upDev = rp?.peerDeviceId ? ctx.network?.devices[rp.peerDeviceId] : undefined;
  const desig = upDev && ctx.network ? getStpBridgeOper(ctx.network, upDev).bridgeId : oper.bridgeId;
  const rootPort = oper.isRoot ? "Root" : (oper.rootPortId ? d.interfaces.find((i) => i.id === oper.rootPortId)?.name : undefined) ?? "NA";
  return [
    "",
    `VLAN ${vid} - STP instance ${inst}`,
    "--------------------------------------------------------------------",
    "STP Bridge Parameters:",
    fmt(["Bridge", "Bridge", "Bridge", "Bridge", "Hold", "LastTopology", "Topology"], W_BRIDGE),
    fmt(["Identifier", "MaxAge", "Hello", "FwdDly", "Time", "Change", "Change"], W_BRIDGE),
    fmt(["hex", "sec", "sec", "sec", "sec", "sec", "cnt"], W_BRIDGE),
    fmt([hexId(oper.bridgeId, vid), oper.maxAge, oper.helloTime, oper.forwardDelay, 1, 0, 0], W_BRIDGE),
    "",
    fmt(["RootBridge", "RootPath", "DesignatedBridge", "RootPort", "Max", "Hel", "Fwd"], W_ROOT),
    fmt(["Identifier", "Cost", "Identifier", "", "Age", "lo", "Dly"], W_ROOT),
    fmt(["hex", "", "hex", "", "sec", "sec", "sec"], W_ROOT),
    fmt([hexId(oper.rootBridgeId, vid), oper.rootPathCost, hexId(desig, vid), rootPort, oper.maxAge, oper.helloTime, oper.forwardDelay], W_ROOT),
    "",
    "STP Port Parameters:",
    fmt(["Port", "Prio", "Path", "Port", "Uplink", "State", "Designated", "Designated", "Designated"], W_PORT),
    fmt(["Name", "rity", "Cost", "Fast", "Fast", "", "Cost", "Root", "Bridge"], W_PORT),
  ];
}

function portRow(ctx: CommandContext, oper: StpBridgeOper, vid: number, p: StpBridgeOper["ports"][string]): string {
  const d = ctx.device;
  const peerDev = p.peerDeviceId ? ctx.network?.devices[p.peerDeviceId] : undefined;
  const peer = p.role !== "Designated" && peerDev && ctx.network ? getStpBridgeOper(ctx.network, peerDev) : undefined;
  const desigCost = peer ? peer.rootPathCost : oper.rootPathCost;
  const desigBridge = peer ? peer.bridgeId : oper.bridgeId;
  const cfg = intfCfg(d, p.interfaceName);
  const portFast = cfg.portfast === true || (cpGet(d, "stp")?.portfast === true && cfg.portfast !== false);
  const state = p.role === "Disabled" ? "DISABLED" : p.state;
  return fmt([p.interfaceName, p.priority, p.cost, portFast ? "Y" : "N", cfg.uplinkfast === true ? "Y" : "N", state, desigCost, hexId(oper.rootBridgeId, vid), hexId(desigBridge, vid)], W_PORT);
}

/** show_stp_vlan [+ show_stp_interface]: the mode line once, then each VLAN. */
function renderVlans(ctx: CommandContext, vids: number[], onlyIf?: string): string[] {
  const d = ctx.device;
  if (!ctx.network) return [];
  const oper = getStpBridgeOper(ctx.network, d);
  const all = stpVlans(d);
  const out: string[] = [];
  let modeShown = false;
  for (const vid of vids) {
    if (!all.includes(vid)) continue;
    if (!modeShown) out.push(`Spanning-tree Mode: ${stpMode(d)}`);
    modeShown = true;
    out.push(...vlanHeader(ctx, oper, vid, all.indexOf(vid)));
    for (const p of vlanPorts(d, oper, vid)) if (onlyIf === undefined || p.interfaceName === onlyIf) out.push(portRow(ctx, oper, vid, p));
  }
  return out;
}

function renderBpduGuard(d: Device): string[] {
  const out: string[] = [];
  const rows = cpList(d, "stp", "interfaces").filter((r) => r.bpduguard === true && r.enable !== false);
  for (const r of rows.sort((a, b) => natCompare(String(a.ifname), String(b.ifname)))) {
    if (!out.length) out.push(fmt(["PortNum", "Shutdown", "Port Shut"], [17, 13]), fmt(["", "Configured", "due to BPDU guard"], [17, 13]), "-------------------------------------------");
    out.push(fmt([String(r.ifname), r.bpduguard_shutdown ? "Yes" : "No", r.bpduguard_shutdown ? "No" : "NA"], [17, 13]));
  }
  return out;
}

function renderRootGuard(d: Device): string[] {
  const out: string[] = [];
  const rows = cpList(d, "stp", "interfaces").filter((r) => r.guard === "root" && r.enable !== false);
  const vids = stpVlans(d);
  for (const r of rows.sort((a, b) => natCompare(String(a.ifname), String(b.ifname)))) {
    if (!out.length) out.push(`Root guard timeout: ${(cpGet(d, "stp")?.rootguard_timeout as number | undefined) ?? 30} secs`, "", fmt(["Port", "VLAN", "Current State"], [17, 7]), "-------------------------------------------");
    for (const v of vids) if (vlanMembers(d, v).some((m) => m.port === r.ifname)) out.push(fmt([String(r.ifname), v, "Consistent state"], [17, 7]));
  }
  return out;
}

function renderStatistics(ctx: CommandContext, vids: number[]): string[] {
  const d = ctx.device;
  if (!ctx.network) return [];
  const oper = getStpBridgeOper(ctx.network, d);
  const all = stpVlans(d);
  const c = stpCounters(d);
  const out: string[] = [];
  for (const vid of vids) {
    if (!all.includes(vid)) continue;
    out.push(`VLAN ${vid} - STP instance ${all.indexOf(vid)}`, "--------------------------------------------------------------------", fmt(["PortNum", "BPDU Tx", "BPDU Rx", "TCN Tx", "TCN Rx"], [17, 15, 15, 15]));
    for (const p of vlanPorts(d, oper, vid)) {
      const n = c[p.interfaceName];
      out.push(fmt([p.interfaceName, n?.tx ?? "-", n?.rx ?? "-", 0, 0], [17, 15, 15, 15]));
    }
  }
  return out;
}

const L = (ss: string[]) => ({ output: ss.map((s) => line(s)) });
const notSwitch = () => ({ output: [muted("% Spanning tree is only supported on switches.")] });

/** `<vlanid>` (type=int, required) of the vlan groups. */
function vlanArg(cmd: string, usage: string, tok: string | undefined): number | OutputLine[] {
  if (tok === undefined) return clickUsageError(cmd, usage, 'Missing argument "<vlanid>".');
  if (!/^-?\d+$/.test(tok)) return clickUsageError(cmd, usage, `Invalid value for "<vlanid>": ${tok} is not a valid integer`);
  return Number(tok);
}

const stpClick: SonicCmd[] = [
  {
    path: ["spanning-tree", "vlan"],
    summary: "Show spanning_tree vlan <vlanid> information",
    run(args, ctx) {
      if (!isSwitch(ctx.device.type)) return notSwitch();
      const usage = "<vlanid> COMMAND [ARGS]...";
      const vid = vlanArg("show spanning-tree vlan", usage, args[0]);
      if (typeof vid !== "number") return { output: vid };
      if (args[1] === undefined) return L(renderVlans(ctx, [vid]));
      if (args[1] !== "interface") return { output: clickUsageError("show spanning-tree vlan", usage, `No such command "${args[1]}".`) };
      if (args[2] === undefined) return { output: clickUsageError("show spanning-tree vlan interface", "<interface_name>", 'Missing argument "<interface_name>".') };
      return L(renderVlans(ctx, [vid], args[2]));
    },
  },
  {
    path: ["spanning-tree", "bpdu_guard"],
    summary: "Show spanning_tree bpdu_guard",
    run: (_a, ctx) => (isSwitch(ctx.device.type) ? L(renderBpduGuard(ctx.device)) : notSwitch()),
  },
  {
    path: ["spanning-tree", "root_guard"],
    summary: "Show spanning_tree root_guard",
    run: (_a, ctx) => (isSwitch(ctx.device.type) ? L(renderRootGuard(ctx.device)) : notSwitch()),
  },
  {
    path: ["spanning-tree", "statistics"],
    summary: "Show spanning_tree statistics",
    run(args, ctx) {
      if (!isSwitch(ctx.device.type)) return notSwitch();
      if (args[0] === undefined) return L(renderStatistics(ctx, stpVlans(ctx.device)));
      if (args[0] !== "vlan") return { output: clickUsageError("show spanning-tree statistics", "COMMAND [ARGS]...", `No such command "${args[0]}".`) };
      const vid = vlanArg("show spanning-tree statistics vlan", "<vlanid>", args[1]);
      if (typeof vid !== "number") return { output: vid };
      return L(renderStatistics(ctx, [vid]));
    },
  },
];

export const stpModule: SonicFeatureModule = {
  id: "stp",
  config: [
    {
      path: ["spanning-tree", "priority"],
      summary: "Set spanning-tree bridge priority (0-61440)",
      run(args, ctx) {
        if (!isSwitch(ctx.device.type)) return { output: [err("% Spanning tree is only supported on switches")] };
        const p = Number(args[0]);
        if (!Number.isInteger(p) || p < 0 || p > 61440) {
          return { output: [err("% Priority must be an integer between 0 and 61440")] };
        }
        cpSet(ctx.device, "stp", "priority", p);
        return { output: [line(`Set spanning-tree priority to ${p}`)] };
      },
    },
    {
      path: ["spanning-tree", "mode"],
      summary: "Set spanning-tree mode (pvst|rapid-pvst|mst)",
      run(args, ctx) {
        if (!isSwitch(ctx.device.type)) return { output: [err("% Spanning tree is only supported on switches")] };
        const m = (args[0] ?? "").toLowerCase();
        if (!["pvst", "rapid-pvst", "mst"].includes(m)) {
          return { output: [err("% Mode must be one of pvst|rapid-pvst|mst")] };
        }
        cpSet(ctx.device, "stp", "mode", m);
        return { output: [line(`Set spanning-tree mode to ${m}`)] };
      },
    },
  ],
  show: [
    {
      path: ["spanning-tree"],
      summary: "Show operational spanning-tree status",
      run(_args, ctx) {
        if (!isSwitch(ctx.device.type)) {
          return { output: [muted("% Spanning tree is only supported on switches.")] };
        }
        const st = cpGet(ctx.device, "stp");
        const mode = (st?.mode as string | undefined) ?? "rpvst";
        const oper = ctx.network ? getStpBridgeOper(ctx.network, ctx.device) : undefined;
        const out: OutputLine[] = [line(`Spanning-tree Mode: ${mode.toUpperCase()}`)];

        if (oper) {
          out.push(line(`Root Bridge ID: ${oper.rootBridgeId}`));
          if (oper.isRoot) {
            out.push(line("  This bridge is the root"));
          } else {
            const rpName = oper.rootPortId
              ? ctx.device.interfaces.find((i) => i.id === oper.rootPortId)?.name ?? oper.rootPortId
              : "None";
            out.push(line(`  Root Path Cost: ${oper.rootPathCost}, Root Port: ${rpName}`));
          }
          out.push(line(`Bridge ID: ${oper.bridgeId}`));
          out.push(line(`  Hello Time: ${oper.helloTime} sec, Max Age: ${oper.maxAge} sec, Forward Delay: ${oper.forwardDelay} sec`));
          out.push(line(""));

          const dash = "-".repeat(60);
          out.push(line("Interface    Role    Status    Cost      Prio.Nbr  Type"));
          out.push(line(dash));

          const roleMap: Record<string, string> = { Root: "Root", Designated: "Desg", Alternate: "Altn", Disabled: "Disb" };
          const stateMap: Record<string, string> = { FORWARDING: "FWD", BLOCKING: "BLK", LEARNING: "LRN" };

          const sortedPorts = Object.values(oper.ports).sort((a, b) => a.portNumber - b.portNumber);
          for (const p of sortedPorts) {
            const r = (roleMap[p.role] ?? p.role).padEnd(8);
            const s = (stateMap[p.state] ?? p.state).padEnd(10);
            const c = String(p.cost).padEnd(10);
            const pn = `${p.priority}.${p.portNumber}`.padEnd(10);
            out.push(line(`${p.interfaceName.padEnd(13)}${r}${s}${c}${pn}P2p`));
          }
        }
        return { output: out };
      },
    },
    {
      path: ["stp"],
      summary: "Show operational spanning-tree status (alias)",
      run(args, ctx) {
        return stpModule.show[0].run(args, ctx);
      },
    },
    ...stpClick,
  ],
};
