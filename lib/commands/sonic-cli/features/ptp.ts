/**
 * PTP (Precision Time Protocol) — CONFIG-PLANE feature (no engine backend).
 *
 * The real box configures a single GLOBAL PTP clock instance (PTP_CLOCK) plus a
 * list of PTP ports (PTP_PORT). We model that CONFIG_DB honestly: config commands
 * write to the config-plane store and `show ptp` renders exactly what was
 * configured. Nothing operational is fabricated.
 *
 *   sonic(config)# ptp mode boundary-clock
 *   sonic(config)# ptp domain 1
 *   sonic(config)# ptp priority1 128
 *   sonic(config)# ptp network-transport ipv4 unicast
 *   sonic(config)# ptp port add Ethernet 64 role master
 *   sonic(config)# no ptp domain
 *   sonic# show ptp [clock|port]
 *
 * Real KLISH grammar: data/device-capture/klish-xml/ptp.xml (VIEW configure-view).
 * Data-plane note: the sim does NOT run the PTP engine — no clock synchronisation,
 * BMCA, servo, parent selection or operational port state is simulated. Operational
 * `show ptp` views (parent/servo/time-property/clock detail) reflect no runtime data.
 */
import { line, err, muted, OutputLine } from "../../types";
import { Device } from "../../../models/device";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, CpState } from "../config-plane";

const MODES = ["boundary-clock", "end-to-end-transparent-clock", "disable"];
const TRANSPORTS = ["l2", "ipv4", "ipv6"];
const TRANSPORT_MODES = ["unicast", "multicast"];
const PROFILES = ["default", "g8275.1", "g8275.2"];
const TWO_STEP = ["enable", "disable"];
const ROLES = ["dynamic", "master", "slave"];

function intInRange(v: string, lo: number, hi: number): number | null {
  if (!/^-?\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= lo && n <= hi ? n : null;
}

registerModal({
  id: "ptp",
  views: ["configure-view"],
  keywords: ["ptp"],
  run({ isNo, args, ctx }) {
    const dev = ctx.device;
    const sub = (args[0] ?? "").toLowerCase();

    // bare `ptp` (container) / `no ptp` (delete all PTP settings)
    if (!sub) {
      if (isNo) for (const k of Object.keys(cpGet(dev, "ptp") ?? {})) cpUnset(dev, "ptp", k);
      return { output: [] };
    }

    switch (sub) {
      case "mode": {
        if (isNo) { cpUnset(dev, "ptp", "mode"); return { output: [] }; }
        const v = (args[1] ?? "").toLowerCase();
        if (!MODES.includes(v)) return { output: [err(`% ptp mode must be one of ${MODES.join("|")}`)] };
        cpSet(dev, "ptp", "mode", v);
        return { output: [] };
      }
      case "domain": {
        if (isNo) { cpUnset(dev, "ptp", "domain"); return { output: [] }; }
        const n = intInRange(args[1] ?? "", 0, 127);
        if (n === null) return { output: [err("% ptp domain must be an integer 0..127")] };
        cpSet(dev, "ptp", "domain", n);
        return { output: [] };
      }
      case "domain-profile": {
        if (isNo) { cpUnset(dev, "ptp", "domain-profile"); return { output: [] }; }
        const v = (args[1] ?? "").toLowerCase();
        if (!PROFILES.includes(v)) return { output: [err(`% ptp domain-profile must be one of ${PROFILES.join("|")}`)] };
        cpSet(dev, "ptp", "domain-profile", v);
        return { output: [] };
      }
      case "priority1":
      case "priority2": {
        if (isNo) { cpUnset(dev, "ptp", sub); return { output: [] }; }
        const n = intInRange(args[1] ?? "", 0, 255);
        if (n === null) return { output: [err(`% ptp ${sub} must be an integer 0..255`)] };
        cpSet(dev, "ptp", sub, n);
        return { output: [] };
      }
      case "two-step": {
        if (isNo) { cpUnset(dev, "ptp", "two-step"); return { output: [] }; }
        const v = (args[1] ?? "").toLowerCase();
        if (!TWO_STEP.includes(v)) return { output: [err(`% ptp two-step must be one of ${TWO_STEP.join("|")}`)] };
        cpSet(dev, "ptp", "two-step", v);
        return { output: [] };
      }
      case "network-transport": {
        if (isNo) { cpUnset(dev, "ptp", "network-transport"); cpUnset(dev, "ptp", "transport-mode"); return { output: [] }; }
        const t = (args[1] ?? "").toLowerCase();
        const m = (args[2] ?? "").toLowerCase();
        if (!TRANSPORTS.includes(t)) return { output: [err(`% ptp network-transport type must be one of ${TRANSPORTS.join("|")}`)] };
        if (!TRANSPORT_MODES.includes(m)) return { output: [err(`% ptp network-transport must be ${TRANSPORT_MODES.join("|")}`)] };
        cpSet(dev, "ptp", "network-transport", t);
        cpSet(dev, "ptp", "transport-mode", m);
        return { output: [] };
      }
      case "ipv6-scope": {
        if (isNo) { cpUnset(dev, "ptp", "ipv6-scope"); return { output: [] }; }
        const v = args[1] ?? "";
        if (!/^0[xX][0-9a-fA-F]$/.test(v)) return { output: [err("% ptp ipv6-scope must be a hex nibble 0x0..0xf")] };
        cpSet(dev, "ptp", "ipv6-scope", v);
        return { output: [] };
      }
      case "announce-timeout": {
        if (isNo) { cpUnset(dev, "ptp", "announce-timeout"); return { output: [] }; }
        const n = intInRange(args[1] ?? "", 2, 10);
        if (n === null) return { output: [err("% ptp announce-timeout must be an integer 2..10")] };
        cpSet(dev, "ptp", "announce-timeout", n);
        return { output: [] };
      }
      case "log-announce-interval":
      case "log-sync-interval":
      case "log-min-delay-req-interval": {
        if (isNo) { cpUnset(dev, "ptp", sub); return { output: [] }; }
        const n = intInRange(args[1] ?? "", -128, 127);
        if (n === null) return { output: [err(`% ptp ${sub} must be an integer -128..127`)] };
        cpSet(dev, "ptp", sub, n);
        return { output: [] };
      }
      case "source-interface": {
        if (isNo) { cpUnset(dev, "ptp", "source-interface"); return { output: [] }; }
        const intf = args.slice(1).join(" ");
        if (!intf) return { output: [err("% ptp source-interface requires an interface")] };
        cpSet(dev, "ptp", "source-interface", intf);
        return { output: [] };
      }
      case "port":
        return { output: portConfig(dev, isNo, args.slice(1)) };
      default:
        return { output: [err(`% Unknown ptp subcommand "${sub}"`)] };
    }
  },
});

// `ptp port add|del Ethernet <id> [role <r>] [local-priority <v>]`
function portConfig(dev: Device, isNo: boolean, a: string[]): OutputLine[] {
  const op = (a[0] ?? "").toLowerCase(); // add | del
  if ((a[1] ?? "").toLowerCase() !== "ethernet" || !a[2]) return [err("% ptp port requires: <add|del> Ethernet <id>")];
  const iface = `Ethernet${a[2]}`;
  if (op === "del" || isNo) { cpRemove(dev, "ptp", "ports", "interface", iface); return []; }
  if (op !== "add") return [err('% ptp port operation must be "add" or "del"')];

  const item: Record<string, unknown> = { interface: iface };
  const al = a.map((s) => s.toLowerCase());
  const ri = al.indexOf("role");
  if (ri >= 0) {
    const role = (a[ri + 1] ?? "").toLowerCase();
    if (!ROLES.includes(role)) return [err(`% ptp port role must be one of ${ROLES.join("|")}`)];
    item.role = role;
  }
  const li = al.indexOf("local-priority");
  if (li >= 0) {
    const n = intInRange(a[li + 1] ?? "", 1, 255);
    if (n === null) return [err("% ptp port local-priority must be an integer 1..255")];
    item["local-priority"] = n;
  }
  cpUpsert(dev, "ptp", "ports", item, "interface");
  return [];
}

function renderPorts(st: CpState): OutputLine[] {
  const ports = (st.ports as Record<string, unknown>[] | undefined) ?? [];
  if (!ports.length) return [];
  const out = [line("PTP Ports")];
  for (const p of ports) {
    const parts = [String(p.interface)];
    if (p.role !== undefined) parts.push(`role ${p.role}`);
    if (p["local-priority"] !== undefined) parts.push(`local-priority ${p["local-priority"]}`);
    out.push(line(`  ${parts.join("  ")}`));
  }
  return out;
}

registerModal({
  id: "ptp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ptp") return null; // not ours
    const st: CpState = cpGet(ctx.device, "ptp") ?? {};
    const view = args[1]?.toLowerCase();

    if (view === "port") {
      const p = renderPorts(st);
      return { output: p.length ? p : [muted("No PTP ports configured")] };
    }
    // Operational views have no config-plane data — the PTP engine is not simulated.
    if (view && view !== "clock") {
      return { output: [muted(`% show ptp ${args.slice(1).join(" ")}: operational PTP state is not simulated (config-plane only)`)] };
    }

    // clock / bare `show ptp`: render only configured PTP_CLOCK values.
    const rows: [string, string][] = [];
    const push = (label: string, key: string) => { if (st[key] !== undefined) rows.push([label, String(st[key])]); };
    push("Mode", "mode");
    if (st["network-transport"] !== undefined) {
      const m = st["transport-mode"] !== undefined ? ` ${st["transport-mode"]}` : "";
      rows.push(["Network Transport", `${st["network-transport"]}${m}`]);
    }
    push("IPv6 Scope", "ipv6-scope");
    push("Domain Number", "domain");
    push("Domain Profile", "domain-profile");
    push("Priority1", "priority1");
    push("Priority2", "priority2");
    push("Two Step", "two-step");
    push("Announce Timeout", "announce-timeout");
    push("Log Announce Interval", "log-announce-interval");
    push("Log Sync Interval", "log-sync-interval");
    push("Log Min Delay Req Interval", "log-min-delay-req-interval");
    push("Source Interface", "source-interface");

    const out: OutputLine[] = [];
    if (rows.length) {
      out.push(line("PTP Clock Configuration"));
      const w = Math.max(...rows.map(([l]) => l.length));
      for (const [l, v] of rows) out.push(line(`  ${l.padEnd(w)}  ${v}`));
    }
    const ports = renderPorts(st);
    if (rows.length && ports.length) out.push(line(""));
    out.push(...ports);
    return { output: out.length ? out : [muted("No PTP configuration")] };
  },
});
