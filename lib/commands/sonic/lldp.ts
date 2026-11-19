/**
 * LLDP SONiC feature module. `config lldp ...` mutates the simulated CONFIG_DB
 * (device.config.features["lldp"]), which the lldpd model in
 * lib/protocols/lldp-daemon.ts reads (timer, multiplier, system name/description,
 * global + per-port rx/tx). `show lldp table|neighbors|statistics` render ONLY
 * neighbours learned from received LLDPDUs (never derived from the topology):
 *
 *   show lldp table        sonic-utilities show/main.py:1591-1596 → scripts/lldpshow
 *                          (tabulate summary, "Total entries displayed:  N")
 *   show lldp neighbors    show/main.py:1576-1589 → `lldpshow -d [-p <port>]` → raw
 *                          lldpctl text (lldpd src/client/display.c + text_writer.c)
 *
 * Commands use the click-style `config lldp` / `show lldp` family (path
 * ["lldp", ...]); the fields, enum values and validation ranges come from
 * lldp.txt, whose management-framework forms they mirror one-to-one:
 *
 *   config lldp enable                          <- lldp enable
 *   config lldp disable                         <- no lldp enable
 *   config lldp transmit                        <- lldp transmit
 *   config lldp no-transmit                     <- no lldp transmit
 *   config lldp receive                         <- lldp receive
 *   config lldp no-receive                      <- no lldp receive
 *   config lldp timer <5-254>                   <- lldp timer <n>
 *   config lldp no-timer                        <- no lldp timer
 *   config lldp multiplier <1-10>               <- lldp multiplier <n>
 *   config lldp no-multiplier                   <- no lldp multiplier
 *   config lldp system-name <name>              <- lldp system-name <name>
 *   config lldp no-system-name                  <- no lldp system-name
 *   config lldp system-description <text ...>   <- lldp system-description "<text>"
 *   config lldp no-system-description           <- no lldp system-description
 *   config lldp interface <port> <enable|disable|transmit|no-transmit|receive|no-receive>
 *                                               <- interface <port> / lldp {enable|receive|transmit}
 *   show lldp                                    <- show lldp / show running-configuration lldp
 *   show lldp table                             <- show lldp table
 *   show lldp neighbors [port]                  <- show lldp neighbor [<port>]
 *   show lldp statistics [port]                 <- show lldp statistics [<port>]
 *
 * Ranges are the XML ptypes confirmed in lldp.txt (AGENT block): timer 5..254
 * (LLDP_HELLO_TIME_TYPE, TC-16/17/18), multiplier 1..10 (LLDP_MULTIPLIER_TYPE,
 * TC-21/22/23). Out-of-range values are rejected ("% Error: Invalid input
 * detected") and leave the previously configured value intact (TC-19/24).
 * `no ...` knob removal clears the value (TC-20/25/27). LLDP defaults ON with
 * both transmit and receive enabled (AGENT finding: default-ON in CONFIG_DB).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { interfaceByName, Device } from "../../models/device";
import { CAP_NAMES, LldpNeighbor, lldpRuntime } from "../../protocols/lldp-daemon";

/** Per-interface LLDP overrides (undefined = inherit the default, i.e. enabled). */
interface LldpPortState {
  name: string;
  enabled: boolean;
  transmit: boolean;
  receive: boolean;
  /** KLISH `network-policy <n>` (LLDP-MED network policy profile advertised on the port). */
  networkPolicy?: number;
}

interface LldpState {
  enabled: boolean;
  transmit: boolean;
  receive: boolean;
  timer: number | undefined;
  multiplier: number | undefined;
  systemName: string | undefined;
  systemDescription: string | undefined;
  interfaces: Record<string, LldpPortState>;
}

/** ptype LLDP_HELLO_TIME_TYPE (lldp.txt TC-16/17/18). */
const TIMER = { min: 5, max: 254 };
/** ptype LLDP_MULTIPLIER_TYPE (lldp.txt TC-21/22/23). */
const MULT = { min: 1, max: 10 };

const INVALID = "% Error: Invalid input detected";

function state(ctx: CommandContext): LldpState {
  return featureState<LldpState>(ctx.device, "lldp", () => ({
    enabled: true,
    transmit: true,
    receive: true,
    timer: undefined,
    multiplier: undefined,
    systemName: undefined,
    systemDescription: undefined,
    interfaces: {},
  }));
}

/** Parse an integer token and check it falls within [min, max]; else null. */
function parseInRange(tok: string | undefined, range: { min: number; max: number }): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  return n >= range.min && n <= range.max ? n : null;
}

/** Get (creating on first use) the per-interface override record for a port. */
function portState(st: LldpState, name: string): LldpPortState {
  if (!st.interfaces[name]) st.interfaces[name] = { name, enabled: true, transmit: true, receive: true };
  return st.interfaces[name];
}

/** KLISH interface `[no] network-policy <1-128>`: bind the profile lldpd advertises as LLDP-MED. */
export function setLldpNetworkPolicy(ctx: CommandContext, port: string, profile: number | undefined): void {
  const p = portState(state(ctx), port);
  if (profile === undefined) delete p.networkPolicy;
  else p.networkPolicy = profile;
}

const config: SonicCmd[] = [
  {
    path: ["lldp", "enable"],
    summary: "Enable LLDP globally",
    run(_args, ctx): CommandResult {
      state(ctx).enabled = true;
      return { output: [muted("LLDP enabled")] };
    },
  },
  {
    path: ["lldp", "disable"],
    summary: "Disable LLDP globally",
    run(_args, ctx): CommandResult {
      state(ctx).enabled = false;
      return { output: [muted("LLDP disabled")] };
    },
  },
  {
    path: ["lldp", "transmit"],
    summary: "Enable LLDP frame transmission globally",
    run(_args, ctx): CommandResult {
      state(ctx).transmit = true;
      return { output: [muted("LLDP transmit enabled")] };
    },
  },
  {
    path: ["lldp", "no-transmit"],
    summary: "Disable LLDP frame transmission globally",
    run(_args, ctx): CommandResult {
      state(ctx).transmit = false;
      return { output: [muted("LLDP transmit disabled")] };
    },
  },
  {
    path: ["lldp", "receive"],
    summary: "Enable LLDP frame reception globally",
    run(_args, ctx): CommandResult {
      state(ctx).receive = true;
      return { output: [muted("LLDP receive enabled")] };
    },
  },
  {
    path: ["lldp", "no-receive"],
    summary: "Disable LLDP frame reception globally",
    run(_args, ctx): CommandResult {
      state(ctx).receive = false;
      return { output: [muted("LLDP receive disabled")] };
    },
  },
  {
    path: ["lldp", "timer"],
    summary: `Set the LLDP tx-interval / hello timer (${TIMER.min}-${TIMER.max} s)`,
    run(args, ctx): CommandResult {
      const tok = positional(args)[0];
      const n = parseInRange(tok, TIMER);
      // Out-of-range is rejected and leaves the existing timer intact (TC-17/18/19).
      if (n === null) return { output: [err(`${INVALID}: timer must be ${TIMER.min}-${TIMER.max} (got '${tok ?? ""}')`)] };
      state(ctx).timer = n;
      return { output: [muted(`LLDP tx-interval set to ${n}`)] };
    },
  },
  {
    path: ["lldp", "no-timer"],
    summary: "Restore the default LLDP timer",
    run(_args, ctx): CommandResult {
      state(ctx).timer = undefined;
      return { output: [muted("LLDP timer restored to default")] };
    },
  },
  {
    path: ["lldp", "multiplier"],
    summary: `Set the LLDP holdtime multiplier (${MULT.min}-${MULT.max})`,
    run(args, ctx): CommandResult {
      const tok = positional(args)[0];
      const n = parseInRange(tok, MULT);
      // Out-of-range is rejected and leaves the existing multiplier intact (TC-22/23/24).
      if (n === null) return { output: [err(`${INVALID}: multiplier must be ${MULT.min}-${MULT.max} (got '${tok ?? ""}')`)] };
      state(ctx).multiplier = n;
      return { output: [muted(`LLDP holdtime multiplier set to ${n}`)] };
    },
  },
  {
    path: ["lldp", "no-multiplier"],
    summary: "Restore the default LLDP multiplier",
    run(_args, ctx): CommandResult {
      state(ctx).multiplier = undefined;
      return { output: [muted("LLDP multiplier restored to default")] };
    },
  },
  {
    path: ["lldp", "system-name"],
    summary: "Set the advertised LLDP system name",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config lldp system-name <name>")] };
      state(ctx).systemName = name;
      return { output: [muted(`LLDP system-name set to ${name}`)] };
    },
  },
  {
    path: ["lldp", "no-system-name"],
    summary: "Clear the advertised LLDP system name",
    run(_args, ctx): CommandResult {
      state(ctx).systemName = undefined;
      return { output: [muted("LLDP system-name cleared")] };
    },
  },
  {
    path: ["lldp", "system-description"],
    summary: "Set the advertised LLDP system description",
    run(args, ctx): CommandResult {
      const text = positional(args).join(" ").trim();
      if (!text) return { output: [err("Usage: config lldp system-description <text>")] };
      state(ctx).systemDescription = text;
      return { output: [muted(`LLDP system-description set to "${text}"`)] };
    },
  },
  {
    path: ["lldp", "no-system-description"],
    summary: "Clear the advertised LLDP system description",
    run(_args, ctx): CommandResult {
      state(ctx).systemDescription = undefined;
      return { output: [muted("LLDP system-description cleared")] };
    },
  },
  {
    path: ["lldp", "interface"],
    summary: "Per-interface LLDP: <port> <enable|disable|transmit|no-transmit|receive|no-receive>",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const portName = pos[0];
      const action = pos[1];
      const usage = "Usage: config lldp interface <port> <enable|disable|transmit|no-transmit|receive|no-receive>";
      if (!portName || !action) return { output: [err(usage)] };
      if (!interfaceByName(ctx.device, portName)) {
        return { output: [err(`config lldp interface: no such interface '${portName}'`)] };
      }
      const port = portState(state(ctx), portName);
      switch (action) {
        case "enable": port.enabled = true; break;
        case "disable": port.enabled = false; break;
        case "transmit": port.transmit = true; break;
        case "no-transmit": port.transmit = false; break;
        case "receive": port.receive = true; break;
        case "no-receive": port.receive = false; break;
        default: return { output: [err(usage)] };
      }
      return { output: [muted(`LLDP ${portName}: ${action}`)] };
    },
  },
];

/** Interfaces on which LLDP is effectively active given global + per-port state. */
function activePorts(ctx: CommandContext, st: LldpState | undefined): string[] {
  const names = ctx.device.interfaces.filter((i) => !i.management).map((i) => i.name);
  // LLDP defaults ON: an unconfigured device (st undefined) is active on all ports.
  if (st && !st.enabled) return [];
  return names.filter((n) => st?.interfaces[n]?.enabled !== false);
}

function renderSummary(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<LldpState>(ctx.device, "lldp");
  const mode = st === undefined || (st.transmit && st.receive)
    ? "rx+tx"
    : st.transmit
      ? "tx-only"
      : st.receive
        ? "rx-only"
        : "off";
  const out: OutputLine[] = [
    line("LLDP Global Configuration"),
    line(`  Admin state          : ${st?.enabled === false ? "disabled" : "enabled"}`),
    line(`  Mode                 : ${mode}`),
    line(`  TX interval (timer)  : ${st?.timer ?? "default"}`),
    line(`  TX hold multiplier   : ${st?.multiplier ?? "default"}`),
    line(`  System name          : ${st?.systemName ?? "(default)"}`),
    line(`  System description   : ${st?.systemDescription ?? "(default)"}`),
  ];
  const overrides = Object.values(st?.interfaces ?? {});
  if (overrides.length > 0) {
    out.push(line("Per-interface overrides"));
    for (const p of overrides.sort((a, b) => a.name.localeCompare(b.name))) {
      const m = p.transmit && p.receive ? "rx+tx" : p.transmit ? "tx-only" : p.receive ? "rx-only" : "off";
      out.push(line(`  ${p.name.padEnd(12)} : ${p.enabled ? "enabled" : "disabled"}, ${m}`));
    }
  }
  return out;
}

// ---------- live neighbour views (lldpd runtime, lib/protocols/lldp-daemon.ts) ----------

/** Neighbours per local port, ports in lldpshow order (alphanum_key, lldpshow:161-167). */
function learned(device: Device): { port: string; nb: LldpNeighbor }[] {
  const rt = lldpRuntime(device);
  if (!rt) return [];
  const key = (s: string) => [s.replace(/\d+/g, ""), Number(s.match(/\d+/)?.[0] ?? 0)] as const;
  return Object.keys(rt.neighbors)
    .sort((a, b) => {
      const [la, na] = key(a);
      const [lb, nb] = key(b);
      return la < lb ? -1 : la > lb ? 1 : na - nb;
    })
    .flatMap((port) => rt.neighbors[port].map((nb) => ({ port, nb })));
}

/** lldpshow parse_cap (lldpshow:113-125): enabled Router→R, Bridge→B, any other→O. */
function capCodes(nb: LldpNeighbor): string {
  let s = "";
  for (const [bit, name] of CAP_NAMES) {
    if (!(nb.capAvailable & bit) || !(nb.capEnabled & bit)) continue;
    s += name === "Router" ? "R" : name === "Bridge" ? "B" : "O";
  }
  return s;
}

/** python-tabulate "simple" for string columns (MIN_PADDING 2, right-stripped). */
function tabulate(headers: string[], rows: string[][]): string[] {
  const w = headers.map((h, c) => Math.max(h.length + 2, ...rows.map((r) => r[c].length)));
  const fmt = (r: string[]) => r.map((v, c) => v.padEnd(w[c])).join("  ").trimEnd();
  return [fmt(headers), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(fmt)];
}

/** `show lldp table` → lldpshow summary (lldpshow:180-190). */
function renderTable(ctx: CommandContext): OutputLine[] {
  const rows = learned(ctx.device).map(({ port, nb }) => [port, nb.sysName ?? "", nb.portId, capCodes(nb), nb.portDescr ?? ""]);
  return [
    line("Capability codes: (R) Router, (B) Bridge, (O) Other"),
    ...tabulate(["LocalPort", "RemoteDevice", "RemotePortID", "Capability", "RemotePortDescr"], rows).map((t) => line(t)),
    line("-".repeat(50)),
    line(`Total entries displayed:  ${rows.length}`),
  ];
}

const CHASSIS_SUBTYPE: Record<number, string> = { 1: "chassis", 2: "ifalias", 3: "port", 4: "mac", 5: "ip", 6: "ifname", 7: "local" };
const PORT_SUBTYPE: Record<number, string> = { 1: "ifalias", 2: "port", 3: "mac", 4: "ip", 5: "ifname", 6: "agentcid", 7: "local" };

/** lldpctl display_age (src/client/display.c:684-694). */
export function lldpAge(secs: number): string {
  const d = Math.floor(secs / 86400);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d} day${d > 1 ? "s" : ""}, ${p(Math.floor(secs / 3600) % 24)}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}`;
}

/** One neighbour as lldpctl's text writer prints it (display.c:713-763, text_writer.c). */
function lldpctlBlock(port: string, nb: LldpNeighbor, now: number): string[] {
  const age = Math.max(0, Math.floor((now - nb.lastChange) / 1000));
  const out = [
    `Interface:    ${port}, via: LLDP, RID: ${nb.rid}, Time: ${lldpAge(age)}`,
    "  Chassis:     ",
    `    ChassisID:    ${CHASSIS_SUBTYPE[nb.chassisSubtype] ?? "unhandled"} ${nb.chassisId}`,
  ];
  if (nb.sysName !== undefined) out.push(`    SysName:      ${nb.sysName}`);
  if (nb.sysDescr !== undefined) out.push(`    SysDescr:     ${nb.sysDescr}`);
  if (nb.mgmtIp) {
    out.push(`    MgmtIP:       ${nb.mgmtIp}`);
    if (nb.mgmtIfIndex) out.push(`    MgmtIface:    ${nb.mgmtIfIndex}`);
  }
  for (const [bit, name] of CAP_NAMES) if (nb.capAvailable & bit) out.push(`    Capability:   ${name}, ${nb.capEnabled & bit ? "on" : "off"}`);
  out.push("  Port:        ", `    PortID:       ${PORT_SUBTYPE[nb.portSubtype] ?? "unhandled"} ${nb.portId}`);
  if (nb.portDescr !== undefined) out.push(`    PortDescr:    ${nb.portDescr}`);
  if (nb.ttl > 0) out.push(`    TTL:          ${nb.ttl}`);
  // Dot3 (display.c:380-470), then VLANs and LLDP-MED at the interface level (display.c:613-647, 60-140).
  if (nb.mfs) out.push(`    MFS:          ${nb.mfs}`);
  if (nb.aggId) out.push(`    Port is aggregated. PortAggregID: ${nb.aggId}`);
  const mp = nb.macphy;
  if (mp && (mp.autonegSupport || mp.autonegEnabled || mp.mau > 0)) {
    out.push(`    PMD autoneg:  supported: ${mp.autonegSupport ? "yes" : "no"}, enabled: ${mp.autonegEnabled ? "yes" : "no"}`);
    out.push(`      MAU oper type: ${MAU_NAMES[mp.mau] ?? "unknown"}`);
  }
  for (const v of nb.vlans ?? []) out.push(`  VLAN:         ${v.vid}, pvid: ${v.vid === nb.pvid ? "yes" : "no"} ${v.name}`);
  if (nb.pvid && !(nb.vlans ?? []).some((v) => v.vid === nb.pvid)) out.push(`  VLAN:         ${nb.pvid}, pvid: yes`);
  if (nb.medType) {
    out.push("  LLDP-MED:     ", `    Device Type:  ${MED_TYPES[nb.medType] ?? "unknown"}`);
    for (const [bit, name] of MED_CAPS) if ((nb.medCap ?? 0) & bit) out.push(`    Capability:   ${name}, yes`);
    for (const p of nb.medPolicies ?? []) {
      out.push(`    LLDP-MED Network Policy for: ${MED_APPS[p.type] ?? "unknown"}, Defined: ${p.unknown ? "no" : "yes"}`);
      if (p.tagged) out.push(`      VLAN:         ${p.vid === 0 ? "priority" : p.vid === 4095 ? "reserved" : p.vid}`);
      out.push(`      Priority:     ${MED_PRIO[p.priority]}`, `      PCP:          ${p.priority}`, `      DSCP Value:   ${p.dscp}`);
    }
  }
  return out;
}

/** lldpctl string maps (lib/atoms/port.c:60-270, chassis.c:41-46, med.c:101-127, display.c:73-79). */
const MAU_NAMES: Record<number, string> = {
  11: "10BaseTFD - UTP MAU, full duplex mode",
  16: "100BaseTXFD - 2 pair category 5 UTP, full duplex mode",
  30: "1000BaseTFD - Four-pair Category 5 UTP, full duplex mode",
  71: "40GbaseCR4 - 40GBASE-R PCS/PMA over 4 lane shielded copper balanced cable",
  98: "100GbaseCR4 - 100GBASE-R PCS/PMA over 4 lane shielded copper balanced cable",
  117: "50GbaseCR - 50GBASE-R PCS/PMA over shielded copper balanced cable PMD",
};
const MED_TYPES: Record<number, string> = { 1: "Generic Endpoint (Class I)", 2: "Media Endpoint (Class II)", 3: "Communication Device Endpoint (Class III)", 4: "Network Connectivity Device" };
const MED_CAPS: [number, string][] = [[0x01, "Capabilities"], [0x02, "Policy"], [0x04, "Location"], [0x08, "MDI/PSE"], [0x10, "MDI/PD"], [0x20, "Inventory"]];
const MED_APPS: Record<number, string> = { 1: "Voice", 2: "Voice Signaling", 3: "Guest Voice", 4: "Guest Voice Signaling", 5: "Softphone Voice", 6: "Video Conferencing", 7: "Streaming Video", 8: "Video Signaling" };
const MED_PRIO = ["Best effort", "Background", "Excellent effort", "Critical applications", "Video", "Voice", "Internetwork control", "Network control"];

const LLDPCTL_SEP = "-".repeat(79);

/**
 * `show lldp neighbors [<port>]` → `lldpshow -d [-p <port>]` → raw `lldpctl`
 * (lldpshow:84-106, 175-179). lldpctl lists eth0 first (ifindex order). With a
 * port that has no neighbour the port name is absent from lldpctl's output and
 * lldpshow prints an empty line (lldpshow:101-103).
 */
function renderNeighbors(ctx: CommandContext, portArg: string | undefined): OutputLine[] {
  const now = Date.now();
  const rank = (p: string) => (p.startsWith("eth") ? 0 : 1);
  let rows = learned(ctx.device).sort((a, b) => rank(a.port) - rank(b.port));
  if (portArg) {
    rows = rows.filter((r) => r.port === portArg);
    if (rows.length === 0) return [line("")];
  }
  const out = [LLDPCTL_SEP, "LLDP neighbors:", LLDPCTL_SEP];
  for (const r of rows) out.push(...lldpctlBlock(r.port, r.nb, now), LLDPCTL_SEP);
  return [...out, ""].map((t) => line(t));
}

// ---------- KLISH (sonic-mgmt-framework CLI) views ----------

/** OpenConfig LLDP capability identities (openconfig-lldp-types), JSON map order = sorted. */
const OC_CAP: [number, string, string][] = (
  [
    [0x40, "DOCSIS_CABLE_DEVICE", "D"],
    [0x04, "MAC_BRIDGE", "B"],
    [0x01, "OTHER", "?"],
    [0x02, "REPEATER", "O"],
    [0x10, "ROUTER", "R"],
    [0x80, "STATION_ONLY", "S"],
    [0x20, "TELEPHONE", "T"],
    [0x08, "WLAN_ACCESS_POINT", "W"],
  ] as [number, string, string][]
);

/** openconfig-lldp chassis/port id types → template prefixes (lldp_neighbor_show.j2:97-126). */
const OC_CHASSIS_TYPE: Record<number, string> = { 4: "mac", 5: "network", 6: "ifname", 7: "local" };
const OC_PORT_TYPE: Record<number, string> = { 3: "mac", 4: "network", 5: "ifname", 7: "local" };
const ocId = (types: Record<number, string>, subtype: number, id: string) => (types[subtype] ? `${types[subtype]} ${id}` : id);
/** jinja2 truncate(n, killwords=True, end='...', leeway=0). */
const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);

/** Interfaces in the order sonic-cli-lldp.py sorts them (name_to_int_val), eth0 last. */
function klishLearned(device: Device, ifname?: string): { port: string; nb: LldpNeighbor }[] {
  const rank = (p: string) => (p.startsWith("eth") ? 1 : 0);
  const firstPerPort = new Map<string, LldpNeighbor>();
  for (const r of learned(device)) if (!firstPerPort.has(r.port)) firstPerPort.set(r.port, r.nb); // neighbor[0]
  return [...firstPerPort.entries()]
    .map(([port, nb]) => ({ port, nb }))
    .filter((r) => !ifname || r.port === ifname)
    .sort((a, b) => rank(a.port) - rank(b.port));
}

/** KLISH `show lldp` / `show lldp table` — renderer/templates/lldp_show.j2. */
export function renderKlishLldpTable(device: Device): OutputLine[] {
  const sep = "-".repeat(119);
  const out = [sep, `${"LocalPort".padEnd(20)}${"RemoteDevice".padEnd(30)}${"RemotePortID".padEnd(20)}${"Capability".padEnd(12)}${"RemotePortDescr".padEnd(38)}`, sep];
  for (const { port, nb } of klishLearned(device)) {
    const caps = OC_CAP.filter(([bit]) => nb.capAvailable & bit && nb.capEnabled & bit).map(([, , c]) => c).join("");
    out.push(
      `${trunc(port, 19).padEnd(20)}${trunc(nb.sysName ?? "", 29).padEnd(30)}${trunc(nb.portId, 19).padEnd(20)}${caps.padEnd(12)}${trunc(nb.portDescr ?? "", 37).padEnd(38)}`,
    );
  }
  return out.map((t) => line(t));
}

/** KLISH `show lldp neighbor [<ifname>]` — renderer/templates/lldp_neighbor_show.j2. */
export function renderKlishLldpNeighbor(device: Device, ifname?: string): OutputLine[] {
  const sep = "-".repeat(59);
  const out = [sep, "LLDP Neighbors".padEnd(20), sep];
  const now = Date.now();
  for (const { port, nb } of klishLearned(device, ifname)) {
    const age = Math.max(0, Math.floor((now - nb.lastChange) / 1000));
    const p = (n: number) => String(n).padStart(2, "0");
    const time = age ? `, Time: ${Math.floor(age / 86400)} day, ${p(Math.floor(age / 3600) % 24)}:${p(Math.floor(age / 60) % 60)}:${p(age % 60)}` : "";
    // The template's blank lines between its {% set %} blocks survive trim_blocks.
    out.push("", "", "", "", "");
    out.push(`Interface:    ${port}, via: LLDP, RID: ${nb.rid}${time}`, "  Chassis:", `    ChassisID:    ${ocId(OC_CHASSIS_TYPE, nb.chassisSubtype, nb.chassisId)}`);
    out.push(`    SysName:      ${nb.sysName ?? ""}`, `    SysDescr:     ${nb.sysDescr ?? ""}`);
    if (nb.mgmtIp) out.push(`    MgmtIP:       ${nb.mgmtIp}`);
    for (const [bit, name] of OC_CAP) if (nb.capAvailable & bit) out.push(`    Capability:   ${name}, ${nb.capEnabled & bit ? "ON" : "OFF"}`);
    out.push("  Port", `    PortID:       ${ocId(OC_PORT_TYPE, nb.portSubtype, nb.portId)}`, `    PortDescr:    ${nb.portDescr ?? ""}`, `    TTL:          ${nb.ttl}`, sep);
  }
  return out.map((t) => line(t));
}

function renderStatistics(ctx: CommandContext, portArg: string | undefined): OutputLine[] {
  if (portArg && !interfaceByName(ctx.device, portArg)) {
    return [err(`show lldp statistics: no such interface '${portArg}'`)];
  }
  const ports = portArg ? [portArg] : ctx.device.interfaces.map((i) => i.name);
  const st = lldpRuntime(ctx.device)?.stats ?? {};
  const out: OutputLine[] = [line("LLDP Statistics")];
  for (const p of ports) {
    const s = st[p];
    out.push(line(`Interface: ${p}`));
    out.push(line(`  Transmitted : ${s?.tx ?? 0}`));
    out.push(line(`  Received : ${s?.rx ?? 0}`));
    out.push(line(`  Discarded : ${s?.discarded ?? 0}`));
    out.push(line(`  Unrecognized TLV : ${s?.unrecognized ?? 0}`));
    out.push(line(`  Ageout : ${s?.ageout ?? 0}`));
  }
  return out;
}

const show: SonicCmd[] = [
  { path: ["lldp", "table"], summary: "Show LLDP neighbors in tabular format", run: (_a, ctx) => ({ output: renderTable(ctx) }) },
  {
    path: ["lldp", "neighbors"],
    summary: "Show LLDP neighbors (optionally one port)",
    run: (a, ctx) => ({ output: renderNeighbors(ctx, positional(a)[0]) }),
  },
  {
    path: ["lldp", "neighbor"],
    summary: "Alias of `show lldp neighbors`",
    run: (a, ctx) => ({ output: renderNeighbors(ctx, positional(a)[0]) }),
  },
  {
    path: ["lldp", "statistics"],
    summary: "Show LLDP per-interface statistics (optionally one port)",
    run: (a, ctx) => ({ output: renderStatistics(ctx, positional(a)[0]) }),
  },
  { path: ["lldp"], summary: "Show LLDP global configuration", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
];

export const lldpModule: SonicFeatureModule = { id: "lldp", config, show };
