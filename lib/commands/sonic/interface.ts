/**
 * Interface SONiC feature module. Config changes mutate the SAME interface model
 * the packet engine reads, so they produce real state transitions (connected
 * routes rebuilt; ping starts/stops working). The click forms mirror the
 * interface operations exercised in interface.txt — IPv4 addressing
 * (`ip address 10.10.10.1/24` / `no ip address ...`, TC-4/TC-5) and admin state
 * (`shutdown` / `no shutdown`, TC-10/TC-11) — expressed as SONiC click commands
 * (see index.ts help). Follows the ./vlan.ts pattern.
 *
 *   config interface ip add <port> <ip>/<prefix>
 *   config interface ip del <port> <ip>/<prefix>
 *   config interface startup <port>
 *   config interface shutdown <port>
 *   show interfaces <alias|description|tpid|transceiver …|switchport …|…>  (Click, below)
 *   show subinterfaces status
 *
 * NOTE: `show interfaces status`, `show ip interfaces`, `show mac` live in
 * ./common.ts and are intentionally NOT re-implemented here.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional, clickGroup, clickGroupUsage, clickUsageError } from "./types";
import { Device, interfaceByName, isSwitch, isHost } from "../../models/device";
import { NetInterface, primaryIpv4, createInterface } from "../../models/interface";
import { isValidIpv4, isValidPrefix } from "../../models/ip";
import { isValidMac, isUnicast, normalizeMac, generateMac } from "../../models/mac";
import { rebuildConnectedRoutes } from "../../models/factory";
import { refreshLink } from "../../models/topology";
import { listVlans, vlanMembers } from "../../models/vlan-ops";
import { lagConfigs } from "../../protocols/lacp-daemon";
import { cpGet, cpList } from "../sonic-cli/config-plane";
import { optic } from "../sonic-cli/features/transceiver-show";
import { natCompare } from "./counters";
import { gridTable } from "./sflow";

function findPort(ctx: CommandContext, name: string | undefined): NetInterface | undefined {
  return name ? interfaceByName(ctx.device, name) : undefined;
}

/** Parse an `<ip>/<prefix>` token into a validated address, or null. */
function parseCidr(tok: string | undefined): { address: string; prefix: number } | null {
  if (!tok || !tok.includes("/")) return null;
  const [address, prefixTok] = tok.split("/");
  const prefix = Number(prefixTok);
  if (!isValidIpv4(address) || !isValidPrefix(prefix)) return null;
  return { address, prefix };
}

const config: SonicCmd[] = [
  {
    path: ["interface", "ip", "add"],
    summary: "Assign an IPv4 address to a port",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      // VLAN_INTERFACE: an existing VLAN's SVI is created on first use, as KLISH `interface Vlan <id>` does.
      const vid = /^Vlan(\d+)$/.exec(pos[0] ?? "")?.[1];
      if (vid && listVlans(ctx.device).some((v) => v.id === Number(vid)) && !findPort(ctx, pos[0])) {
        // same id / MAC derivation as ensureInterface + logicalMac in ../sonic-cli.ts (not importable: cycle)
        let seed = 0x0e0000;
        for (const c of ctx.device.id) seed = (seed * 31 + c.charCodeAt(0)) & 0xffffff;
        const svi = createInterface(`${ctx.device.id}-${pos[0].toLowerCase()}`, pos[0], generateMac(seed));
        svi.logical = true;
        svi.operState = "up";
        ctx.device.interfaces.push(svi);
      }
      const iface = findPort(ctx, pos[0]);
      if (!iface) return { output: [err(`config interface ip add: no such interface '${pos[0] ?? ""}'`)] };
      const cidr = parseCidr(pos[1]);
      if (!cidr) return { output: [err("Usage: config interface ip add <port> <ip>/<prefix>")] };
      if (iface.ipv4.some((a) => a.address === cidr.address && a.prefix === cidr.prefix)) {
        return { output: [muted(`${iface.name} already has ${cidr.address}/${cidr.prefix}`)] };
      }
      iface.ipv4.push({ address: cidr.address, prefix: cidr.prefix });
      rebuildConnectedRoutes(ctx.device);
      return { output: [muted(`${cidr.address}/${cidr.prefix} added to ${iface.name}`)] };
    },
  },
  {
    path: ["interface", "ip", "del"],
    summary: "Remove an IPv4 address from a port",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = findPort(ctx, pos[0]);
      if (!iface) return { output: [err(`config interface ip del: no such interface '${pos[0] ?? ""}'`)] };
      const cidr = parseCidr(pos[1]);
      if (!cidr) return { output: [err("Usage: config interface ip del <port> <ip>/<prefix>")] };
      const before = iface.ipv4.length;
      iface.ipv4 = iface.ipv4.filter((a) => !(a.address === cidr.address && a.prefix === cidr.prefix));
      if (iface.ipv4.length === before) {
        return { output: [err(`${iface.name} has no address ${cidr.address}/${cidr.prefix}`)] };
      }
      rebuildConnectedRoutes(ctx.device);
      return { output: [muted(`${cidr.address}/${cidr.prefix} removed from ${iface.name}`)] };
    },
  },
  {
    path: ["interface", "startup"],
    summary: "Bring a port administratively up",
    run(args, ctx): CommandResult {
      const port = positional(args)[0];
      const iface = findPort(ctx, port);
      if (!iface) return { output: [err(`config interface startup: no such interface '${port ?? ""}'`)] };
      iface.adminState = "up";
      // Carrier needs both ends enabled: recompute this port and the cable's far end.
      for (const id of refreshLink(ctx.network, ctx.device.id, iface.id)) rebuildConnectedRoutes(ctx.network.devices[id] ?? ctx.device);
      return { output: [muted(`${iface.name} admin up`)] };
    },
  },
  {
    path: ["interface", "shutdown"],
    summary: "Shut a port down administratively",
    run(args, ctx): CommandResult {
      const port = positional(args)[0];
      const iface = findPort(ctx, port);
      if (!iface) return { output: [err(`config interface shutdown: no such interface '${port ?? ""}'`)] };
      iface.adminState = "down";
      iface.operState = "down";
      // Laser off: the far end of the cable loses carrier too.
      for (const id of refreshLink(ctx.network, ctx.device.id, iface.id)) rebuildConnectedRoutes(ctx.network.devices[id] ?? ctx.device);
      return { output: [muted(`${iface.name} admin down`)] };
    },
  },
  {
    path: ["interface", "mac"],
    summary: "Assign hardware MAC address to a port",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const port = pos[0];
      const mac = pos[1];
      const iface = findPort(ctx, port);
      if (!iface) return { output: [err(`config interface mac: no such interface '${port ?? ""}'`)] };
      if (!mac || !isValidMac(mac) || !isUnicast(mac)) {
        return { output: [err("Usage: config interface mac <port> <unicast-mac>")] };
      }
      iface.mac = normalizeMac(mac);
      return { output: [muted(`${iface.name} MAC set to ${iface.mac}`)] };
    },
  },
];

function renderInterfaces(ctx: CommandContext): OutputLine[] {
  const out: OutputLine[] = [
    line("Interface      Admin      Oper     MAC                 IPv4 address/mask"),
    line("-------------  ---------  -------  ------------------  ---------------------"),
  ];
  for (const i of ctx.device.interfaces) {
    const ip = primaryIpv4(i);
    out.push(
      line(
        `${i.name.padEnd(13)}  ${i.adminState.padEnd(9)}  ${i.operState.padEnd(7)}  ${i.mac.padEnd(18)}  ${ip ? `${ip.address}/${ip.prefix}` : "-"}`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Click `show interfaces …` / `show subinterfaces …` (sonic-utilities
// show/interfaces/__init__.py, show/main.py:604-628, scripts/intfutil,
// scripts/sfpshow, sfputil/main.py, utilities_common/cli.py). Rendered from the
// live device model. What SONiC keeps in tables the simulator does not model is
// shown the way the box shows an absent field (N/A / Never / empty):
//  - alias: port_config.ini alias of the N-th front-panel port, "etpN";
//  - description / DEVICE_NEIGHBOR: the cabled peer (minigraph style "S2:Ethernet0");
//  - FEC "none", MTU 9100, TPID 0x8100, autoneg / link-training not configured;
//  - optics: a cabled port holds the passive DAC of the KLISH transceiver handler,
//    an empty port has no module.
// ---------------------------------------------------------------------------

const lines = (t: string[]): OutputLine[] => t.map((s) => line(s));
const MTU = "9100";

/**
 * python-tabulate tablefmt="simple" (MIN_PADDING 2) with multi-line cells. Columns whose
 * cells are all integers are right-aligned (numalign decimal); text follows `align`.
 */
export function tab(headers: string[], rows: string[][], align: "left" | "right" = "left"): string[] {
  const cellLines = (v: string) => v.split("\n");
  const w = headers.map((h, c) => Math.max(h.length + 2, ...rows.flatMap((r) => cellLines(r[c] ?? "").map((x) => x.length))));
  const num = headers.map((_, c) => rows.length > 0 && rows.every((r) => /^-?\d+$/.test(r[c] ?? "")));
  const pad = (v: string, c: number) => (align === "right" || num[c] ? v.padStart(w[c]) : v.padEnd(w[c]));
  const out = [headers.map(pad).join("  ").trimEnd(), w.map((n) => "-".repeat(n)).join("  ")];
  for (const r of rows) {
    const cl = headers.map((_, c) => cellLines(r[c] ?? ""));
    const h = Math.max(...cl.map((x) => x.length));
    for (let k = 0; k < h; k++) out.push(cl.map((x, c) => pad(x[k] ?? "", c)).join("  ").trimEnd());
  }
  return out;
}

/** Front-panel ports in natural order (PORT table). */
export function frontPanel(d: Device): NetInterface[] {
  return d.interfaces.filter((i) => !i.logical && !i.management && /^Ethernet\d+$/.test(i.name)).sort((a, b) => natCompare(a.name, b.name));
}

/** PORT|<port> alias: "etpN" for the N-th front-panel port (as in CONFIG_DB). */
export function portAlias(d: Device, name: string): string | undefined {
  const k = frontPanel(d).findIndex((i) => i.name === name);
  return k < 0 ? undefined : `etp${k + 1}`;
}

/** intfutil port_speed_parse. */
function speedStr(mbps: number): string {
  if (mbps < 1000) return `${mbps}M`;
  if (mbps % 1000 >= 100) return `${(mbps / 1000).toFixed(1)}G`;
  return `${Math.round(mbps / 1000)}G`;
}

const portChannels = (d: Device) => lagConfigs(d).sort((a, b) => natCompare(a.name, b.name));
const isPortChannel = (d: Device, n: string) => lagConfigs(d).some((l) => l.name === n);

/** The device and port at the far end of a cable (DEVICE_NEIGHBOR). */
function peerOf(ctx: CommandContext, i: NetInterface): { dev: Device; port: NetInterface } | undefined {
  if (!i.connectedTo) return undefined;
  const dev = ctx.network?.devices[i.connectedTo.deviceId];
  const port = dev?.interfaces.find((x) => x.id === i.connectedTo!.interfaceId);
  return dev && port ? { dev, port } : undefined;
}

function description(ctx: CommandContext, i: NetInterface): string {
  const p = peerOf(ctx, i);
  return p ? `${p.dev.name}:${p.port.name}` : "N/A";
}

/** Front-panel ports selected by an optional <interfacename> (intfutil -i). */
function selectPorts(d: Device, name: string | undefined): NetInterface[] {
  const all = frontPanel(d);
  return name === undefined ? all : all.filter((i) => i.name === name);
}

const ifArg = (args: string[]) => positional(args)[0];

function showAlias(args: string[], ctx: CommandContext): OutputLine[] {
  const name = ifArg(args);
  const d = ctx.device;
  if (name !== undefined && !portAlias(d, name)) return clickUsageError("show interfaces alias", "[INTERFACENAME]", `Invalid interface name ${name}`);
  return lines(tab(["Name", "Alias"], selectPorts(d, name).map((i) => [i.name, portAlias(d, i.name)!])));
}

function showDescription(args: string[], ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const rows = selectPorts(d, ifArg(args)).map((i) => [i.name, i.operState, i.adminState, portAlias(d, i.name)!, description(ctx, i)]);
  return lines(tab(["Interface", "Oper", "Admin", "Alias", "Description"], rows, "right"));
}

function lagState(d: Device, name: string): { oper: string; admin: string } {
  const i = d.interfaces.find((x) => x.name === name);
  return { oper: i?.operState ?? "N/A", admin: i?.adminState ?? "N/A" };
}

function showTpid(args: string[], ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const name = ifArg(args);
  const rows = selectPorts(d, name).map((i) => [i.name, portAlias(d, i.name)!, i.operState, i.adminState, "0x8100"]);
  for (const po of portChannels(d)) {
    if (name !== undefined && name !== po.name) continue;
    const st = lagState(d, po.name);
    rows.push([po.name, "N/A", st.oper, st.admin, "0x8100"]);
  }
  return lines(tab(["Interface", "Alias", "Oper", "Admin", "TPID"], rows, "right"));
}

function showAutoneg(args: string[], ctx: CommandContext): OutputLine[] {
  const rows = selectPorts(ctx.device, ifArg(args)).map((i) => [i.name, "N/A", speedStr(i.speed), "N/A", "N/A", "N/A", "N/A", i.operState, i.adminState]);
  return lines(tab(["Interface", "Auto-Neg Mode", "Speed", "Adv Speeds", "Rmt Adv Speeds", "Type", "Adv Types", "Oper", "Admin"], rows, "right"));
}

function showLinkTraining(args: string[], ctx: CommandContext): OutputLine[] {
  const rows = selectPorts(ctx.device, ifArg(args)).map((i) => [i.name, "N/A", "N/A", i.operState, i.adminState]);
  return lines(tab(["Interface", "LT Oper", "LT Admin", "Oper", "Admin"], rows, "right"));
}

function showFec(args: string[], ctx: CommandContext): OutputLine[] {
  const rows = selectPorts(ctx.device, ifArg(args)).map((i) => [i.name, i.operState === "up" ? "none" : "N/A", "none"]);
  return lines(tab(["Interface", "FEC Oper", "FEC Admin"], rows, "right"));
}

function showNamingMode(ctx: CommandContext): OutputLine[] {
  const mode = cpGet(ctx.device, "alias")?.intf_naming_mode as string | undefined;
  return [line(mode === "standard" || mode === "standard-ext" ? "alias" : "default")];
}

/** BREAKOUT_CFG brkout_mode: every port runs its native single-lane-group mode. */
const brkoutMode = (i: NetInterface) => `1x${speedStr(i.speed)}`;

function showBreakout(ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const obj: Record<string, unknown> = {};
  frontPanel(d).forEach((i, k) => {
    obj[i.name] = {
      index: String(k + 1),
      lanes: String(k * 4),
      breakout_modes: { [brkoutMode(i)]: [`etp${k + 1}`] },
      default_brkout_mode: brkoutMode(i),
      "Current Breakout Mode": brkoutMode(i),
      "child ports": i.name,
      "child port speeds": speedStr(i.speed),
    };
  });
  return lines(JSON.stringify(obj, null, 4).split("\n"));
}

function showBreakoutCurrent(args: string[], ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const name = ifArg(args);
  const hdr = ["Interface", "Current Breakout Mode"];
  if (name !== undefined) {
    const i = frontPanel(d).find((x) => x.name === name);
    return lines(gridTable(hdr, [[name, i ? brkoutMode(i) : "Not Available"]]));
  }
  return lines(gridTable(hdr, frontPanel(d).map((i) => [i.name, brkoutMode(i)])));
}

/** DEVICE_NEIGHBOR / DEVICE_NEIGHBOR_METADATA from the cabling. */
function showNeighborExpected(args: string[], ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const name = ifArg(args);
  const row = (i: NetInterface): string[] | undefined => {
    const p = peerOf(ctx, i);
    if (!p) return undefined;
    const lo = p.dev.interfaces.find((x) => x.name === "Loopback0")?.ipv4[0];
    const mgmt = p.dev.interfaces.find((x) => x.management)?.ipv4[0];
    const type = isSwitch(p.dev.type) ? "ToRRouter" : isHost(p.dev.type) ? "Server" : "LeafRouter";
    return [i.name, p.dev.name, p.port.name, lo ? `${lo.address}/32` : "None", mgmt ? mgmt.address : "None", type];
  };
  const hdr = ["LocalPort", "Neighbor", "NeighborPort", "NeighborLoopback", "NeighborMgmt", "NeighborType"];
  if (name !== undefined) {
    const i = frontPanel(d).find((x) => x.name === name);
    const r = i && row(i);
    if (!r) return [line(`No neighbor information available for interface ${name}`)];
    return lines(tab(hdr, [r]));
  }
  return lines(tab(hdr, frontPanel(d).map(row).filter((r): r is string[] => !!r)));
}

/** INTF_TABLE router interfaces (Loopbacks hidden), mpls never enabled. */
function showMpls(args: string[], ctx: CommandContext): OutputLine[] {
  const name = ifArg(args);
  const intfs = ctx.device.interfaces.filter((i) => !i.management && (i.ipv4.length || i.ipv6.length));
  if (name !== undefined && !intfs.some((i) => i.name === name)) return clickUsageError("show interfaces mpls", "[INTERFACENAME]", `interface ${name} doesn\`t exist`);
  const rows = intfs
    .filter((i) => (name !== undefined ? i.name === name : !i.name.startsWith("Loopback")))
    .sort((a, b) => natCompare(a.name, b.name))
    .map((i) => [i.name, "disable"]);
  return lines(tab(["Interface", "MPLS State"], rows));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function showFlap(args: string[], ctx: CommandContext): OutputLine[] {
  const name = ifArg(args);
  const d = ctx.device;
  if (name !== undefined && !portAlias(d, name)) return clickUsageError("show interfaces flap", "[INTERFACENAME]", `Invalid interface name ${name}`);
  const rows = selectPorts(d, name).map((i) => [i.name, "Never", cap(i.adminState), cap(i.operState), "Never", "Never"]);
  return lines(tab(["Interface", "Flap Count", "Admin", "Oper", "Link Down TimeStamp(UTC)", "Link Up TimeStamp(UTC)"], rows));
}

const PORT_ERRORS = [
  "oper_error_status", "mac_local_fault", "mac_remote_fault", "fec_sync_loss", "fec_alignment_loss", "high_ser_error", "high_ber_error",
  "data_unit_crc_error", "data_unit_misalignment_error", "signal_local_error", "crc_rate", "data_unit_size", "code_group_error", "no_rx_reachability",
];

function showErrors(args: string[]): OutputLine[] {
  if (ifArg(args) === undefined) return clickUsageError("show interfaces errors", "INTERFACENAME", 'Missing argument "INTERFACENAME".');
  const rows = PORT_ERRORS.map((e) => [e.replace(/_/g, " "), "0", "Never"]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return lines(tab(["Port Errors", "Count", "Last timestamp(UTC)"], rows));
}

/** PORT / PORTCHANNEL keys minus LAG members (show/interfaces switchport). */
function switchportKeys(d: Device): string[] {
  const members = new Set(lagConfigs(d).flatMap((l) => l.members));
  return [...frontPanel(d).map((i) => i.name).filter((n) => !members.has(n)), ...portChannels(d).map((l) => l.name)].sort(natCompare);
}

/** VLAN_MEMBER rows of a port: [vid, tagged] over the configured VLANs. */
function memberships(d: Device, port: string): { vid: number; tagged: boolean }[] {
  return listVlans(d)
    .map((v) => ({ vid: v.id, m: vlanMembers(d, v.id).find((m) => m.port === port) }))
    .filter((x) => x.m)
    .map((x) => ({ vid: x.vid, tagged: x.m!.tagged }))
    .sort((a, b) => natCompare(`Vlan${a.vid}`, `Vlan${b.vid}`));
}

/** clicommon.get_interface_switchport_mode: PORT mode (set by `vlan member add`), else routed. */
function switchportMode(d: Device, port: string): string {
  const ms = memberships(d, port);
  if (!ms.length) return "routed";
  return ms.some((m) => m.tagged) ? "trunk" : "access";
}

function showSwitchport(ctx: CommandContext, withVlans: boolean): OutputLine[] {
  const d = ctx.device;
  const rows = switchportKeys(d).map((k) => {
    if (!withVlans) return [k, switchportMode(d, k)];
    const ms = memberships(d, k);
    const tagged = ms.filter((m) => m.tagged).map((m) => String(m.vid));
    const chunks: string[] = [];
    for (let n = 0; n < Math.floor(tagged.length / 5) + 1; n++) chunks.push(tagged.slice(n * 5, n * 5 + 5).join(" ,"));
    return [k, switchportMode(d, k), ms.filter((m) => !m.tagged).map((m) => String(m.vid)).join("\n"), chunks.join("\n")];
  });
  return lines(tab(withVlans ? ["Interface", "Mode", "Untagged", "Tagged"] : ["Interface", "Mode"], rows));
}

function showDhcpMitigation(args: string[], ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const name = ifArg(args);
  const usage = "[INTERFACENAME]";
  if (name !== undefined && !portAlias(d, name)) {
    const msg = isPortChannel(d, name) ? `${name} is a PortChannel!` : `${name} does not exist`;
    return clickUsageError("show interfaces dhcp-mitigation-rate", usage, msg);
  }
  return lines(tab(["Interface", "DHCP Mitigation Rate"], selectPorts(d, name).map((i) => [i.name, ""])));
}

// --- transceiver (sfpshow / sfputil) -----------------------------------------

/** TRANSCEIVER_INFO of the simulated passive DAC (sff8636 / sff8472 field set). */
function eepromInfo(i: NetInterface): string[] {
  const o = optic(i);
  const g = i.speed / 1000;
  const ident = g >= 400 ? "QSFP-DD Double Density 8X Pluggable Transceiver" : g >= 100 ? "QSFP28 or later" : g >= 40 ? "QSFP+ or later" : "SFP/SFP+/SFP28";
  const ext = g >= 400 ? "Power Level 1 (1.5W max)" : "Power Level 1 Module (1.5W max.)";
  const ind = " ".repeat(8);
  const media = (o.name.split(" ")[1] ?? "").replace(/-1\.0M$/, "");
  const qsfp = g >= 40;
  const spec: [string, string][] = [
    ["10/40G Ethernet Compliance Code", g >= 100 || g === 25 ? "Extended" : g >= 40 ? "40GBASE-CR4" : "10GBASE-CR"],
    ["Extended Specification Compliance", g >= 100 || g === 25 ? media : "Unknown"],
    ["Fibre Channel Link Length", "Unknown"],
    ["Fibre Channel Transmission Media", "Unknown"],
    ["Fibre Channel Transmitter Technology", "Unknown"],
    ["Gigabit Ethernet Compliant Codes", "Unknown"],
    ["SAS/SATA Compliance Codes", "Unknown"],
    ["SONET Compliance Codes", "Unknown"],
  ];
  // keys sorted by their display names (sfp_helper get_data_map_sort_key)
  return [
    `${ind}Connector: No separable connector`,
    `${ind}Encoding: 64B/66B`,
    `${ind}Extended Identifier: ${qsfp ? ext : "N/A"}`,
    `${ind}Extended RateSelect Compliance: ${qsfp ? "QSFP+ Rate Select Version 1" : "N/A"}`,
    `${ind}Identifier: ${ident}`,
    `${ind}Length Cable Assembly(m): 1.0`,
    `${ind}Nominal Bit Rate(100Mbs): 255`,
    `${ind}Specification compliance:`,
    ...spec.map(([k, v]) => `${ind}${ind}${k}: ${v}`),
    `${ind}Vendor Date Code(YYYY-MM-DD Lot): 2024-01-01`,
    `${ind}Vendor Name: SIMULATED`,
    `${ind}Vendor OUI: 00-00-00`,
    `${ind}Vendor PN: SIM-DAC-1M`,
    `${ind}Vendor Rev: A0`,
    `${ind}Vendor SN: SIM${i.name.replace("Ethernet", "").padStart(6, "0")}`,
  ];
}

/** sfpshow display_eeprom / display_pm / display_status: "<port>: <text>\n" joined by "\n". */
function perPort(ports: string[], text: (name: string) => string[]): OutputLine[] {
  const out: string[] = [];
  ports.forEach((p, k) => {
    const [first, ...rest] = text(p);
    if (k) out.push("");
    out.push(`${p}: ${first}`, ...rest);
  });
  if (ports.length) out.push("");
  return lines(out);
}

function xcvrPorts(d: Device, name: string | undefined): string[] {
  return name === undefined ? frontPanel(d).map((i) => i.name) : [name];
}

function showTransceiver(kind: string, args: string[], ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const name = ifArg(args);
  const port = (n: string) => frontPanel(d).find((i) => i.name === n);
  const present = (n: string) => !!port(n) && optic(port(n)!).present;
  switch (kind) {
    case "eeprom":
    case "info":
      return perPort(xcvrPorts(d, name), (n) => (present(n) ? ["SFP EEPROM detected", ...eepromInfo(port(n)!)] : ["SFP EEPROM Not detected"]));
    case "pm":
      return perPort(xcvrPorts(d, name), () => ["Transceiver performance monitoring not applicable"]);
    case "status":
      return perPort(xcvrPorts(d, name), () => ["Transceiver status info not applicable"]);
    case "presence":
      return lines(tab(["Port", "Presence"], xcvrPorts(d, name).map((n) => [n, present(n) ? "Present" : "Not present"])));
    default: {
      // sfputil show lpmode / error-status
      if (name !== undefined && !port(name)) return [line(`Error: invalid port '${name}'`), line("")];
      if (kind === "lpmode") return lines(tab(["Port", "Low-power Mode"], xcvrPorts(d, name).map((n) => [n, "Off"])));
      return lines(tab(["Port", "Error Status"], xcvrPorts(d, name).map((n) => [n, present(n) ? "OK" : "Unplugged"])));
    }
  }
}

// --- subinterfaces (intfutil -c status -i subport) ---------------------------

function showSubinterfaceStatus(args: string[], ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const name = ifArg(args);
  if (name !== undefined && !name.includes(".")) return [line("Invalid sub port interface name")];
  const subifs = cpList(d, "subinterface", "subifs") as { name: string; vlan?: number; admin?: string }[];
  const rows = subifs
    .filter((s) => name === undefined || s.name === name)
    .map((s) => {
      const parentName = s.name.split(".")[0].replace(/^Eth(\d)/, "Ethernet$1").replace(/^Po(\d)/, "PortChannel$1");
      const parent = d.interfaces.find((i) => i.name === parentName);
      const physical = parent && !parent.logical;
      return [s.name, physical ? speedStr(parent.speed) : "N/A", parent ? MTU : "N/A", s.vlan !== undefined ? String(s.vlan) : "", s.admin ?? "up", "802.1q-encapsulation"];
    })
    .sort((a, b) => natCompare(a[0], b[0]));
  return lines(tab(["Sub port interface", "Speed", "MTU", "Vlan", "Admin", "Type"], rows, "right"));
}

const IF_CMDS: [string, string][] = [
  ["alias", "Show Interface Name/Alias Mapping"],
  ["autoneg", "Show interface autoneg information"],
  ["breakout", "Show Breakout Mode information by interfaces"],
  ["counters", "Show interface counters"],
  ["description", "Show interface status, protocol and description"],
  ["dhcp-mitigation-rate", "Show interface dhcp-mitigation-rate information"],
  ["errors", "Show Interface Erorrs <interfacename>"],
  ["fec", "Show interface fec information"],
  ["flap", "Show Interface Flap Information <interfacename>"],
  ["link-training", "Show interface link-training information"],
  ["mpls", "Show Interface MPLS status"],
  ["naming_mode", "Show interface naming_mode status"],
  ["neighbor", "Show neighbor related information"],
  ["portchannel", "Show PortChannel information"],
  ["status", "Show Interface status information"],
  ["switchport", "Show interface switchport information"],
  ["tpid", "Show Interface tpid information"],
  ["transceiver", "Show SFP Transceiver information"],
];

const XCVR_CMDS: [string, string][] = [
  ["eeprom", "Show interface transceiver EEPROM information"],
  ["error-status", "Show transceiver error-status"],
  ["info", "Show interface transceiver information"],
  ["lpmode", "Show interface transceiver low-power mode status"],
  ["pm", "Show interface transceiver performance monitoring information"],
  ["presence", "Show interface transceiver presence"],
  ["status", "Show interface transceiver status information"],
];

const show: SonicCmd[] = [
  // `show interfaces` is a plain Click group on a SONiC switch; hosts keep the address list.
  clickGroup(["interfaces"], "Show details of the network interfaces", IF_CMDS, (ctx) =>
    isSwitch(ctx.device.type) ? clickGroupUsage("show interfaces", "Show details of the network interfaces", IF_CMDS) : renderInterfaces(ctx),
  ),
  { path: ["interfaces", "alias"], summary: "Show Interface Name/Alias Mapping", run: (a, ctx) => ({ output: showAlias(a, ctx) }) },
  { path: ["interfaces", "description"], summary: "Show interface status, protocol and description", run: (a, ctx) => ({ output: showDescription(a, ctx) }) },
  { path: ["interfaces", "naming_mode"], summary: "Show interface naming_mode status", run: (_a, ctx) => ({ output: showNamingMode(ctx) }) },
  { path: ["interfaces", "tpid"], summary: "Show Interface tpid information", run: (a, ctx) => ({ output: showTpid(a, ctx) }) },
  { path: ["interfaces", "breakout"], summary: "Show Breakout Mode information by interfaces", run: (_a, ctx) => ({ output: showBreakout(ctx) }) },
  { path: ["interfaces", "breakout", "current-mode"], summary: "Show current Breakout mode Info by interface(s)", run: (a, ctx) => ({ output: showBreakoutCurrent(a, ctx) }) },
  clickGroup(["interfaces", "neighbor"], "Show neighbor related information", [["expected", "Show expected neighbor information by interfaces"]]),
  { path: ["interfaces", "neighbor", "expected"], summary: "Show expected neighbor information by interfaces", run: (a, ctx) => ({ output: showNeighborExpected(a, ctx) }) },
  { path: ["interfaces", "mpls"], summary: "Show Interface MPLS status", run: (a, ctx) => ({ output: showMpls(a, ctx) }) },
  { path: ["interfaces", "flap"], summary: "Show Interface Flap Information <interfacename>", run: (a, ctx) => ({ output: showFlap(a, ctx) }) },
  { path: ["interfaces", "errors"], summary: "Show Interface Erorrs <interfacename>", run: (a) => ({ output: showErrors(a) }) },
  clickGroup(["interfaces", "autoneg"], "Show interface autoneg information", [["status", "Show interface autoneg status"]]),
  { path: ["interfaces", "autoneg", "status"], summary: "Show interface autoneg status", run: (a, ctx) => ({ output: showAutoneg(a, ctx) }) },
  clickGroup(["interfaces", "link-training"], "Show interface link-training information", [["status", "Show interface link-training status"]]),
  { path: ["interfaces", "link-training", "status"], summary: "Show interface link-training status", run: (a, ctx) => ({ output: showLinkTraining(a, ctx) }) },
  clickGroup(["interfaces", "fec"], "Show interface fec information", [["status", "Show interface fec status"]]),
  { path: ["interfaces", "fec", "status"], summary: "Show interface fec status", run: (a, ctx) => ({ output: showFec(a, ctx) }) },
  clickGroup(["interfaces", "switchport"], "Show interface switchport information", [
    ["config", "Show interface switchport config information"],
    ["status", "Show interface switchport status information"],
  ]),
  { path: ["interfaces", "switchport", "config"], summary: "Show interface switchport config information", run: (_a, ctx) => ({ output: showSwitchport(ctx, true) }) },
  { path: ["interfaces", "switchport", "status"], summary: "Show interface switchport status information", run: (_a, ctx) => ({ output: showSwitchport(ctx, false) }) },
  { path: ["interfaces", "dhcp-mitigation-rate"], summary: "Show interface dhcp-mitigation-rate information", run: (a, ctx) => ({ output: showDhcpMitigation(a, ctx) }) },
  clickGroup(["interfaces", "transceiver"], "Show SFP Transceiver information", XCVR_CMDS),
  ...XCVR_CMDS.map(([k, h]): SonicCmd => ({ path: ["interfaces", "transceiver", k], summary: h, run: (a, ctx) => ({ output: showTransceiver(k, a, ctx) }) })),
  clickGroup(["subinterfaces"], "Show details of the sub port interfaces", [["status", "Show sub port interface status information"]]),
  { path: ["subinterfaces", "status"], summary: "Show sub port interface status information", run: (a, ctx) => ({ output: showSubinterfaceStatus(a, ctx) }) },
];

export const interfaceModule: SonicFeatureModule = { id: "interface", config, show };
