/**
 * Common SONiC `show` commands shared across features (task §17). All output is
 * rendered from live simulated state — never hardcoded.
 *
 *   show interfaces status      show mac / show mac address-table
 *   show ip interfaces          show running-config [vlan|interfaces]
 *   show version
 */
import { CommandContext, CommandResult, OutputLine, line, muted, err } from "../types";
import { SonicFeatureModule, SonicCmd, positional } from "./types";
import { findInterface, interfaceByName, isSwitch, isHost, isRouter } from "../../models/device";
import { listVlans, vlanMembers } from "../../models/vlan-ops";
import { isValidMac, normalizeMac } from "../../models/mac";
import { ipintutil } from "./ipv6";
import { natCompare } from "./counters";
import { lagConfigs } from "../../protocols/lacp-daemon";

/**
 * `show interfaces status` — scripts/intfutil IntfStatus: header_stat (:460), one row per
 * front-panel port then per PortChannel (:513-547), natsorted, tabulate "simple" with
 * stralign='right' (:67-72). Values are the ones the APPL_DB PORT_TABLE / LAG_TABLE
 * projection holds (lib/sonicdb/appl-state-db.ts: lanes, mtu 9100, alias etpN, oper
 * down while admin down); Vlan = PortChannel name for a LAG member, "trunk" for a VLAN
 * member, else "routed" (get_interface_sw_mode_dict :95-113). No FEC / pfc_asym in
 * APPL_DB and no transceiver in STATE_DB → "N/A".
 */
function ifaceStatus(ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const lags = lagConfigs(d);
  const vlanPorts = new Set(listVlans(d).flatMap((v) => vlanMembers(d, v.id).map((m) => m.port)));
  const mode = (n: string) => lags.find((l) => l.members.includes(n))?.name ?? (vlanPorts.has(n) ? "trunk" : "routed");
  const speed = (mbps: number) => (mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);
  const rows: string[][] = [];
  for (const p of d.interfaces.filter((i) => !i.management && !i.logical)) {
    const n = Number(/\d+$/.exec(p.name)?.[0] ?? 0);
    const oper = p.adminState === "up" ? p.operState : "down";
    rows.push([p.name, String(n + 1), speed(p.speed), "9100", "N/A", `etp${n + 1}`, mode(p.name), oper, p.adminState, "N/A", "N/A"]);
  }
  for (const l of lags) {
    const pc = d.interfaces.find((i) => i.name === l.name);
    const sp = l.members.reduce((s, m) => s + (d.interfaces.find((i) => i.name === m)?.speed ?? 0), 0);
    rows.push([l.name, "N/A", sp ? speed(sp) : "N/A", "9100", "N/A", "N/A", vlanPorts.has(l.name) ? "trunk" : "routed", pc?.operState ?? "down", pc?.adminState ?? "up", "N/A", "N/A"]);
  }
  rows.sort((a, b) => natCompare(a[0], b[0]));
  const hdr = ["Interface", "Lanes", "Speed", "MTU", "FEC", "Alias", "Vlan", "Oper", "Admin", "Type", "Asym PFC"];
  const w = hdr.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const fmt = (r: string[]) => r.map((v, c) => v.padStart(w[c])).join("  ");
  return [line(fmt(hdr)), line(w.map((n) => "-".repeat(n)).join("  ")), ...rows.map((r) => line(fmt(r)))];
}

/**
 * `show mac [-v vlan] [-p port] [-a mac] [-t type] [-c]` — scripts/fdbshow:
 * HEADER No./Vlan/MacAddress/Port/Type (fdbshow:73), entries sorted by VLAN
 * (:156), filters (:176-180), default tabulate (numbers right-aligned), then
 * "Total number of entries N" (:189); `-c` prints only the total. fdbshow has
 * no Age column. EVPN-installed remote MACs show the tunnel ("VxLAN DIP: ip"),
 * type Static.
 */
function macTable(ctx: CommandContext, args: string[] = []): OutputLine[] {
  if (!isSwitch(ctx.device.type)) return [muted("MAC table is only available on switches")];
  const opt = (f: string, l: string) => {
    const k = args.findIndex((a) => a === f || a === l);
    return k >= 0 ? args[k + 1] : undefined;
  };
  const vlan = opt("-v", "--vlan");
  const port = opt("-p", "--port");
  const address = opt("-a", "--address");
  const type = opt("-t", "--type");
  if (vlan !== undefined && (!/^\d+$/.test(vlan) || Number(vlan) < 1 || Number(vlan) > 4095)) return [line(`Error: Invalid vlan id ${vlan}`)];
  if (port !== undefined && !ctx.device.interfaces.some((i) => i.name === port)) return [line(`Error: Invalid port ${port}`)];
  if (address !== undefined && !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(address)) return [line(`Error: Invalid mac address ${address}`)];
  const want = type ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() : undefined;
  if (want !== undefined && want !== "Static" && want !== "Dynamic") return [line(`Error: Invalid type ${type}`)];
  const entries = ctx.device.macTable
    .map((m) => {
      const remote = m.interfaceId.startsWith("vtep:");
      const p = remote ? `VxLAN DIP: ${m.interfaceId.slice(5)}` : (findInterface(ctx.device, m.interfaceId)?.name ?? m.interfaceId);
      return { vlan: m.vlan, mac: m.mac.toUpperCase(), port: p, type: remote || m.static ? "Static" : "Dynamic" };
    })
    .filter((e) => (vlan === undefined || e.vlan === Number(vlan)) && (port === undefined || e.port === port) &&
      (address === undefined || e.mac === address.toUpperCase()) && (want === undefined || e.type === want))
    .sort((a, b) => a.vlan - b.vlan);
  const total = line(`Total number of entries ${entries.length}`);
  if (args.includes("-c") || args.includes("--count")) return [total];
  const hdr = ["No.", "Vlan", "MacAddress", "Port", "Type"];
  const rows = entries.map((e, i) => [String(i + 1), String(e.vlan), e.mac, e.port, e.type]);
  const num = [true, true, false, false, false];
  const w = hdr.map((h, c) => Math.max(h.length + 2, ...rows.map((r) => r[c].length)));
  const cell = (v: string, c: number) => (num[c] ? v.padStart(w[c]) : v.padEnd(w[c]));
  return [
    line(hdr.map(cell).join("  ").trimEnd()),
    line(w.map((n) => "-".repeat(n)).join("  ")),
    ...rows.map((r) => line(r.map(cell).join("  ").trimEnd())),
    total,
  ];
}

function runningConfig(ctx: CommandContext, section?: string): OutputLine[] {
  const out: OutputLine[] = [];
  const wantVlan = !section || section === "vlan";
  const wantIf = !section || section === "interfaces" || section === "interface";

  if (wantVlan && isSwitch(ctx.device.type)) {
    const vlans = [...listVlans(ctx.device)].sort((a, b) => a.id - b.id);
    for (const v of vlans) {
      out.push(line(`vlan ${v.id}`));
      for (const m of vlanMembers(ctx.device, v.id)) {
        out.push(line(`  member ${m.port} ${m.tagged ? "tagged" : "untagged"}`));
      }
    }
  }
  if (wantIf) {
    for (const i of ctx.device.interfaces) {
      const hasCfg = i.ipv4.length > 0 || i.adminState === "down";
      if (!hasCfg) continue;
      out.push(line(`interface ${i.name}`));
      if (i.adminState === "down") out.push(line("  shutdown"));
      for (const a of i.ipv4) out.push(line(`  ip address ${a.address}/${a.prefix}`));
    }
  }
  if (out.length === 0) out.push(muted("!"));
  return out;
}

const show: SonicCmd[] = [
  { path: ["interfaces", "status"], summary: "Interface status", run: (_a, ctx) => ({ output: ifaceStatus(ctx) }) },
  { path: ["interface", "status"], summary: "Interface status", run: (_a, ctx) => ({ output: ifaceStatus(ctx) }) },
  { path: ["mac", "address-table"], summary: "MAC address table", run: (a, ctx) => ({ output: macTable(ctx, a) }) },
  { path: ["mac"], summary: "MAC address table", run: (a, ctx) => ({ output: macTable(ctx, a) }) },
  { path: ["ip", "interfaces"], summary: "IPv4 interface addresses", run: (_a, ctx) => ({ output: ipintutil(ctx, "ipv4") }) },
  {
    path: ["running-configuration"],
    summary: "Running configuration",
    run: (a, ctx) => ({ output: runningConfig(ctx, positional(a)[0]) }),
  },
  {
    path: ["running-config"],
    summary: "Running configuration",
    run: (a, ctx) => ({ output: runningConfig(ctx, positional(a)[0]) }),
  },
  {
    path: ["version"],
    summary: "Software version",
    run: (_a, ctx) => ({
      output: [
        line("SONiC Software Version: SONiC-Lab-Simulation"),
        muted(`Platform: networklab-sim   HwSKU: ${isHost(ctx.device.type) ? "host" : isRouter(ctx.device.type) ? "router" : "switch"}`),
        muted("Note: simulated environment (not a real device)."),
      ],
    }),
  },
];

const config: SonicCmd[] = [
  {
    path: ["mac", "add"],
    summary: "Add static MAC address table entry (config mac add <vlan> <mac> <port>)",
    run(args, ctx): CommandResult {
      if (!isSwitch(ctx.device.type)) return { output: [err("MAC configuration is only available on switches")] };
      const pos = positional(args);
      const vlanId = Number(pos[0]);
      const mac = pos[1];
      const portName = pos[2];
      if (!vlanId || !mac || !portName || !isValidMac(mac)) {
        return { output: [err("Usage: config mac add <vlan> <mac> <port>")] };
      }
      const iface = interfaceByName(ctx.device, portName);
      if (!iface) return { output: [err(`config mac add: port '${portName}' not found`)] };
      const normMac = normalizeMac(mac);
      ctx.device.macTable = ctx.device.macTable.filter((e) => !(e.vlan === vlanId && normalizeMac(e.mac) === normMac));
      ctx.device.macTable.push({ mac: normMac, interfaceId: iface.id, vlan: vlanId, static: true });
      return { output: [muted(`Added MAC ${normMac} on VLAN ${vlanId} dev ${iface.name}`)] };
    },
  },
  {
    path: ["mac", "del"],
    summary: "Delete MAC address table entry (config mac del <vlan> <mac>)",
    run(args, ctx): CommandResult {
      if (!isSwitch(ctx.device.type)) return { output: [err("MAC configuration is only available on switches")] };
      const pos = positional(args);
      const vlanId = Number(pos[0]);
      const mac = pos[1];
      if (!vlanId || !mac || !isValidMac(mac)) {
        return { output: [err("Usage: config mac del <vlan> <mac>")] };
      }
      const normMac = normalizeMac(mac);
      const before = ctx.device.macTable.length;
      ctx.device.macTable = ctx.device.macTable.filter((e) => !(e.vlan === vlanId && normalizeMac(e.mac) === normMac));
      if (ctx.device.macTable.length === before) {
        return { output: [err(`config mac del: entry for ${mac} in VLAN ${vlanId} not found`)] };
      }
      return { output: [muted(`Deleted MAC ${normMac} on VLAN ${vlanId}`)] };
    },
  },
  {
    path: ["mac", "clear"],
    summary: "Clear all dynamic MAC address table entries",
    run(_args, ctx): CommandResult {
      if (!isSwitch(ctx.device.type)) return { output: [err("MAC configuration is only available on switches")] };
      const count = ctx.device.macTable.length;
      ctx.device.macTable = [];
      return { output: [muted(`Cleared ${count} entries from MAC table`)] };
    },
  },
];

export const commonModule: SonicFeatureModule = { id: "common", config, show };
