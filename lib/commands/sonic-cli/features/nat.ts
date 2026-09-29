/**
 * NAT — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic(config)# nat                                   -> enter NAT sub-view
 *   sonic(config-nat)# enable                            admin_mode = enabled
 *   sonic(config-nat)# timeout 900                       NAT_GLOBAL nat_timeout
 *   sonic(config-nat)# tcp-timeout 3600                  NAT_GLOBAL nat_tcp_timeout
 *   sonic(config-nat)# udp-timeout 120                   NAT_GLOBAL nat_udp_timeout
 *   sonic(config-nat)# pool p1 65.55.45.1-65.55.45.5 100-200
 *   sonic(config-nat)# binding b1 p1 acl1 snat twice-nat-id 5
 *   sonic(config-nat)# static basic 65.55.42.1 10.0.0.1 dnat
 *   sonic(config-nat)# static tcp 65.55.42.2 100 10.0.0.2 200
 *   sonic(config-nat)# no pool p1 / no pools / no binding b1 / no static all
 *   sonic(config-if)# nat-zone 2                         INTERFACE nat_zone
 *   sonic# show nat config [globalvalues|static|pool|bindings|zones]
 *
 * `nat` (configure-view) opens a DEDICATED SUB-MODE (grammar view
 * "configure-nat-view"), so we use the sub-mode pattern: the entry handler
 * returns `enter: subViewFrame(...)` and the sub-view handler writes the fields
 * into the config-plane store (cp_nat). `nat-zone` is a per-interface attribute
 * configured in the interface sub-views. Everything is rendered back on `show`.
 *
 * NAT is a DATA-PLANE feature (the ASIC rewrites addresses/ports of forwarded
 * traffic). The sim cannot translate live traffic, so we store + show the config
 * honestly and mark dataPlaneNotSimulated. `show nat translations|statistics`
 * are runtime state we never fabricate.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal, ModalResult } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";
import { Device } from "../../../models/device";

type Row = Record<string, string>;
const p = (v: string | undefined, w: number): string => String(v ?? "").padEnd(w);

// configure-view: `nat` — drop into the NAT sub-view (global singleton, no context).
registerModal({
  id: "nat-enter",
  views: ["configure-view"],
  keywords: ["nat"],
  run({ isNo }) {
    if (isNo) return null; // no `no nat` at configure-view level
    return { output: [], enter: subViewFrame("configure-nat-view") };
  },
});

const TIMEOUT_KEYS: Record<string, string> = {
  timeout: "nat_timeout",
  "tcp-timeout": "nat_tcp_timeout",
  "udp-timeout": "nat_udp_timeout",
};

const staticKey = (proto: string, globalIp: string, globalPort: string): string => `${proto}|${globalIp}|${globalPort}`;

/** Scan trailing "[snat|dnat] [twice-nat-id <id>]" options (order-independent). */
function scanOpts(rest: string[]): { natType: string; twice: string } {
  let natType = "---";
  let twice = "---";
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].toLowerCase();
    if (t === "twice-nat-id") twice = rest[++i] ?? "---";
    else if (t === "snat" || t === "dnat") natType = t;
  }
  return { natType, twice };
}

function staticCmd(dev: Device, isNo: boolean, args: string[]): ModalResult {
  const kind = (args[0] ?? "").toLowerCase();
  if (isNo) {
    if (kind === "all") {
      cpSet(dev, "nat", "statics", []);
      return { output: [] };
    }
    if (kind === "basic") {
      if (!args[1]) return { output: [err("% Global-IP required.")] };
      cpRemove(dev, "nat", "statics", "key", staticKey("all", args[1], "---"));
      return { output: [] };
    }
    if (kind === "tcp" || kind === "udp") {
      if (!args[1] || !args[2]) return { output: [err("% Global-IP and Global-port required.")] };
      cpRemove(dev, "nat", "statics", "key", staticKey(kind, args[1], args[2]));
      return { output: [] };
    }
    return { output: [err("% Usage: no static <all | basic <global-ip> | tcp|udp <global-ip> <global-port>>")] };
  }
  if (kind === "basic") {
    const [, gip, lip] = args;
    if (!gip || !lip) return { output: [err("% Global-IP and Local-IP required.")] };
    const { natType, twice } = scanOpts(args.slice(3));
    cpUpsert(
      dev, "nat", "statics",
      { key: staticKey("all", gip, "---"), ip_protocol: "all", global_ip: gip, global_port: "---", local_ip: lip, local_port: "---", nat_type: natType, twice_nat_id: twice },
      "key",
    );
    return { output: [] };
  }
  if (kind === "tcp" || kind === "udp") {
    const [, gip, gport, lip, lport] = args;
    if (!gip || !gport || !lip || !lport) return { output: [err("% Global-IP, Global-port, Local-IP and Local-port required.")] };
    const { natType, twice } = scanOpts(args.slice(5));
    cpUpsert(
      dev, "nat", "statics",
      { key: staticKey(kind, gip, gport), ip_protocol: kind, global_ip: gip, global_port: gport, local_ip: lip, local_port: lport, nat_type: natType, twice_nat_id: twice },
      "key",
    );
    return { output: [] };
  }
  return { output: [err("% Usage: static <basic <global-ip> <local-ip> | tcp|udp <global-ip> <global-port> <local-ip> <local-port>> [snat|dnat] [twice-nat-id <id>]")] };
}

// configure-nat-view: global values, pools, bindings and static entries.
registerModal({
  id: "nat",
  views: ["configure-nat-view"],
  keywords: ["enable", "timeout", "tcp-timeout", "udp-timeout", "pool", "pools", "binding", "bindings", "static"],
  run({ head, isNo, args, ctx }) {
    const dev = ctx.device;
    switch (head) {
      case "enable":
        cpSet(dev, "nat", "admin_mode", isNo ? "disabled" : "enabled");
        return { output: [] };
      case "timeout":
      case "tcp-timeout":
      case "udp-timeout": {
        const key = TIMEOUT_KEYS[head];
        if (isNo) {
          cpUnset(dev, "nat", key);
          return { output: [] };
        }
        if (!args[0] || !/^\d+$/.test(args[0])) return { output: [err(`% ${head} value must be a number.`)] };
        cpSet(dev, "nat", key, args[0]);
        return { output: [] };
      }
      case "pools": // only `no pools`
        if (!isNo) return null;
        cpSet(dev, "nat", "pools", []);
        return { output: [] };
      case "pool": {
        if (!args[0]) return { output: [err("% NAT pool name required.")] };
        if (isNo) {
          cpRemove(dev, "nat", "pools", "pool_name", args[0]);
          return { output: [] };
        }
        if (!args[1]) return { output: [err("% Global IP range required.")] };
        cpUpsert(dev, "nat", "pools", { pool_name: args[0], nat_ip: args[1], nat_port: args[2] ?? "---" }, "pool_name");
        return { output: [] };
      }
      case "bindings": // only `no bindings`
        if (!isNo) return null;
        cpSet(dev, "nat", "bindings", []);
        return { output: [] };
      case "binding": {
        if (!args[0]) return { output: [err("% NAT binding name required.")] };
        if (isNo) {
          cpRemove(dev, "nat", "bindings", "name", args[0]);
          return { output: [] };
        }
        if (!args[1]) return { output: [err("% NAT pool name required.")] };
        let acl = "---";
        const { natType, twice } = scanOpts(args.slice(2));
        for (let i = 2; i < args.length; i++) {
          const t = args[i].toLowerCase();
          if (t === "twice-nat-id") i++; // skip its value
          else if (t !== "snat" && t !== "dnat") acl = args[i];
        }
        cpUpsert(dev, "nat", "bindings", { name: args[0], nat_pool: args[1], access_list: acl, nat_type: natType, twice_nat_id: twice }, "name");
        return { output: [] };
      }
      case "static":
        return staticCmd(dev, isNo, args);
    }
    return null;
  },
});

// configure-if/vlan/lag-view: `nat-zone <zone>` — per-interface NAT zone.
registerModal({
  id: "nat-zone",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["nat-zone"],
  run({ isNo, args, ifname, ctx }) {
    if (!ifname) return null;
    if (isNo) {
      cpRemove(ctx.device, "nat", "zones", "port", ifname);
      return { output: [] };
    }
    if (!args[0] || !/^\d+$/.test(args[0])) return { output: [err("% NAT zone must be a number.")] };
    cpUpsert(ctx.device, "nat", "zones", { port: ifname, zone: args[0] }, "port");
    return { output: [] };
  },
});

const SECTIONS = ["globalvalues", "static", "pool", "bindings", "zones"];

function renderGlobals(st: Record<string, unknown>): OutputLine[] {
  return [
    line("Global Values"),
    line(`Admin Mode      : ${(st.admin_mode as string) ?? "disabled"}`),
    line(`Global Timeout  : ${(st.nat_timeout as string) ?? "600"} secs`),
    line(`TCP Timeout     : ${(st.nat_tcp_timeout as string) ?? "86400"} secs`),
    line(`UDP Timeout     : ${(st.nat_udp_timeout as string) ?? "300"} secs`),
  ];
}

function renderStatic(rows: Row[]): OutputLine[] {
  if (!rows.length) return [muted("No static NAT entries configured")];
  const hdr =
    p("Nat Type", 10) + p("IP Protocol", 13) + p("Global IP", 17) + p("Global L4 Port", 16) + p("Local IP", 17) + p("Local L4 Port", 15) + "Twice-NAT Id";
  const out: OutputLine[] = [line(hdr), muted("-".repeat(hdr.length))];
  for (const r of rows) {
    out.push(line(p(r.nat_type, 10) + p(r.ip_protocol, 13) + p(r.global_ip, 17) + p(r.global_port, 16) + p(r.local_ip, 17) + p(r.local_port, 15) + r.twice_nat_id));
  }
  return out;
}

function renderPool(rows: Row[]): OutputLine[] {
  if (!rows.length) return [muted("No NAT pools configured")];
  const hdr = p("Pool Name", 17) + p("Global IP Range", 28) + "Global Port Range";
  const out: OutputLine[] = [line(hdr), muted("-".repeat(hdr.length))];
  for (const r of rows) out.push(line(p(r.pool_name, 17) + p(r.nat_ip, 28) + r.nat_port));
  return out;
}

function renderBindings(rows: Row[]): OutputLine[] {
  if (!rows.length) return [muted("No NAT bindings configured")];
  const hdr = p("Binding Name", 16) + p("Pool Name", 13) + p("Access-List", 15) + p("Nat Type", 10) + "Twice-NAT Id";
  const out: OutputLine[] = [line(hdr), muted("-".repeat(hdr.length))];
  for (const r of rows) out.push(line(p(r.name, 16) + p(r.nat_pool, 13) + p(r.access_list, 15) + p(r.nat_type, 10) + r.twice_nat_id));
  return out;
}

function renderZones(rows: Row[]): OutputLine[] {
  if (!rows.length) return [muted("No NAT zones configured")];
  const hdr = p("Port", 17) + "Zone";
  const out: OutputLine[] = [line(hdr), muted("-".repeat(hdr.length))];
  for (const r of rows) out.push(line(p(r.port, 17) + r.zone));
  return out;
}

// enable-view: `show nat [config [<section>] | translations | statistics]`.
registerModal({
  id: "nat-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }): ModalResult {
    if (args[0]?.toLowerCase() !== "nat") return null; // not ours
    const rest = args.slice(1).map((a) => a.toLowerCase());
    // Live translations / counters are runtime state — never fabricated.
    if (rest.includes("translations") || rest.includes("statistics")) {
      const what = rest.includes("statistics") ? "statistics" : "translations";
      return { output: [muted(`NAT ${what} reflect live traffic (runtime state); not simulated in this lab.`)] };
    }
    const sel = rest.find((r) => SECTIONS.includes(r));
    const want = sel ? [sel] : SECTIONS;
    const st = cpGet(ctx.device, "nat") ?? {};
    const dev = ctx.device;
    const out: OutputLine[] = [];
    for (const sec of want) {
      if (out.length) out.push(line(""));
      if (sec === "globalvalues") out.push(...renderGlobals(st));
      else if (sec === "static") out.push(...renderStatic(cpList(dev, "nat", "statics") as Row[]));
      else if (sec === "pool") out.push(...renderPool(cpList(dev, "nat", "pools") as Row[]));
      else if (sec === "bindings") out.push(...renderBindings(cpList(dev, "nat", "bindings") as Row[]));
      else if (sec === "zones") out.push(...renderZones(cpList(dev, "nat", "zones") as Row[]));
    }
    return { output: out };
  },
});
