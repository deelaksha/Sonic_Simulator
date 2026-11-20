/**
 * KLISH `show` forms of the L3 / routing family that had no handler (or answered
 * a misleading "% Malformed ..."). Each renders the real actioner/template layout
 * from live simulator state. Template references are the Broadcom SONiC CLI tree
 * (sm-occli/brcm_files/version4.5/cli: actioners *.py, render-templates/*.j2,
 * rendered with trim_blocks/lstrip_blocks).
 *
 *   show ip | show ipv6 | show ip dhcp | show ipv6 dhcp | show bfd | show bgp l2vpn
 *   show evpn arp-cache | mac | next-hops | rmac
 *        container COMMANDs with no ACTION (ipv4.xml:12, ipv6.xml, dhcp_snooping.xml:16/54,
 *        bfd.xml:12, bgp_af_l2vpn.xml:1012, show_evpn.xml:26/50/77/91) — klish runs
 *        nothing, so the device prints nothing.
 *   show hosts                              dns.xml:12, show_hosts.j2
 *   show ip rest [<opt>]                    authentication.xml:20, show_mgmt_rest.j2
 *   show ip telemetry [<opt>]               authentication.xml:35, show_mgmt_telemetry.j2
 *   show ip helper-address [<if>]           ip-helper.xml:40, show_ip_helper_interface_config_sonic.j2
 *   show ip helper-address statistics [<if>] ip-helper.xml:77, show_ip_helper_interface_statistics_sonic.j2
 *   show ip|ipv6 dhcp snooping statistics [detail]
 *                                           dhcp_snooping.xml:46-70, show_ip(v6)_dhcp_snooping_statistics(_detail).j2
 *   show bfd profile [<name>]               bfd.xml:228, show_bfd_profile.j2 (+ the
 *                                           configure-bfd(-profile)-view config that feeds it, bfd.xml:348)
 *   show bgp all [vrf <v>] neighbors [<ip>|interface <if>] | peer-group [<name>]   bgp.xml:299
 *   show bgp ipv4|ipv6 [unicast] vrf <v>|all ...                                  bgp.xml:52/210
 *   show bgp ext-community-list [<name>]    bgp_community_sets.xml:42, show_bgp_extcom.j2
 */
import { OutputLine, line } from "../../types";
import { registerModal } from "../registry";
import { Device } from "../../../models/device";
import { featureState, peekFeatureState } from "../../../models/feature-state";
import { cpRunningLines, cpStoreLine } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";
import { peekSnoopState } from "../../../protocols/dhcp-snooping";
import { bgpVrfNames } from "../../../protocols/bgp";

const L = (rows: string[]): { output: OutputLine[] } => ({ output: rows.map((r) => line(r)) });
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** "Ethernet 0" / "Ethernet0" / "Vlan 10" / "PortChannel 1" (two-word KLISH form) → one name. */
function ifName(tokens: string[]): string | undefined {
  if (!tokens.length) return undefined;
  const joined = /^\d/.test(tokens[1] ?? "") ? tokens[0] + tokens[1] : tokens[0];
  const m = joined.match(/^(ethernet|eth|vlan|portchannel|po|loopback)(\d+(?:\.\d+)?)$/i);
  if (!m) return joined;
  const t = m[1].toLowerCase();
  const type = t.startsWith("e") ? "Ethernet" : t === "vlan" ? "Vlan" : t.startsWith("p") ? "PortChannel" : "Loopback";
  return type + m[2];
}

// --- action-less container commands ------------------------------------------
const CONTAINERS = new Set(["ip", "ipv6", "ip dhcp", "ipv6 dhcp", "bfd", "bgp l2vpn", "evpn arp-cache", "evpn mac", "evpn next-hops", "evpn rmac"]);

registerModal({
  id: "klish-l3-containers",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args }) {
    return CONTAINERS.has(args.join(" ").toLowerCase()) ? { output: [] } : null;
  },
});

// --- show hosts (dns.xml:12; sonic_cli_dns.py get_dns_hosts → show_hosts.j2) ---
registerModal({
  id: "klish-show-hosts",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args.length !== 1 || args[0].toLowerCase() !== "hosts") return null;
    const servers = peekFeatureState<{ nameservers: string[] }>(ctx.device, "dns")?.nameservers ?? [];
    // show_hosts.j2 prints nothing at all when no server is configured.
    return L(servers.length ? [`Name servers are: ${servers.join(", ")}`] : []);
  },
});

// --- show ip rest | show ip telemetry (authentication.xml:20-52) ---------------
/** Stored `ip rest|telemetry <opt> <value>` lines (configure-view, config-plane store). */
function mgmtServerCfg(dev: Device, which: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of cpRunningLines(dev)) {
    const t = l.line.split(/\s+/);
    if (l.ctx !== "config" || t[0] !== "ip" || t[1] !== which || !t[2]) continue;
    out[t[2]] = t[2] === "vrf" ? t[3] ?? "" : t.slice(3).join(" ");
  }
  return out;
}

function showMgmtServer(dev: Device, which: "rest" | "telemetry", field?: string): string[] {
  const c = mgmtServerCfg(dev, which);
  const want = (f: string) => !field || field === f;
  const out = ["", " "];
  if (want("log-level")) out.push(`Log level is ${c["log-level"] || "not-set"}`);
  if (which === "telemetry") {
    if (want("jwt-valid")) out.push(`JWT valid is ${c["jwt-valid"] || 0} seconds`);
    if (want("jwt-refresh")) out.push(`JWT refresh is ${c["jwt-refresh"] || 0} seconds`);
  }
  if (want("port")) {
    const shut = c.port === "shutdown";
    out.push(`Port is ${shut || !c.port ? (which === "rest" ? 443 : 8080) : c.port}${shut ? ", down" : ""}`);
  }
  if (which === "rest") {
    if (want("request-limit")) out.push(`Request limit is ${c["request-limit"] || "not-set"}`);
    if (want("read-timeout")) out.push(`Read timeout is ${c["read-timeout"] || 0} seconds`);
  }
  if (want("authentication")) out.push(`Client authentication mode is ${c.authentication || "password,jwt"}`);
  if (want("security-profile")) out.push(`Security profile is ${c["security-profile"] || "not-set"}`);
  if (want("api-timeout")) out.push(`API timeout is ${c["api-timeout"] || 0} seconds`);
  if (want("vrf")) out.push(`vrf is ${c.vrf || "not-set"}`);
  if (which === "rest" && want("cipher-suite") && c["cipher-suite"]) out.push(`Cipher suite is ${c["cipher-suite"]}`);
  out.push(" ");
  return out;
}

registerModal({
  id: "klish-show-mgmt-servers",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] !== "ip" || (a[1] !== "rest" && a[1] !== "telemetry") || a.length > 3) return null;
    return L(showMgmtServer(ctx.device, a[1], a[2]));
  },
});

// --- show ip helper-address [statistics] [<if>] (ip-helper.xml:40-110) ---------
/** iface → relay servers ("vrf|ip" or "ip"), from stored `ip helper-address [vrf V] A.B.C.D`. */
function helperServers(dev: Device): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const l of cpRunningLines(dev)) {
    const t = l.line.split(/\s+/);
    if (t[0] !== "ip" || t[1] !== "helper-address" || !/^(Ethernet|Vlan|PortChannel)/.test(l.ctx)) continue;
    const entry = t[2] === "vrf" ? `${t[3]}|${t[4]}` : t[2];
    if (!entry) continue;
    m.set(l.ctx, [...(m.get(l.ctx) ?? []), entry]);
  }
  // build_helper_address_info walks INTERFACE, VLAN_INTERFACE, PORTCHANNEL_INTERFACE in that order.
  const rank = (n: string) => (n.startsWith("Ethernet") ? 0 : n.startsWith("Vlan") ? 1 : 2);
  return new Map([...m].sort(([a], [b]) => rank(a) - rank(b) || natural(a, b)));
}

registerModal({
  id: "klish-show-ip-helper",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "helper-address") return null;
    const stats = args[2]?.toLowerCase() === "statistics";
    const want = ifName(args.slice(stats ? 3 : 2));
    const servers = [...helperServers(ctx.device)].filter(([n]) => !want || n === want);
    if (stats) {
      // No UDP-broadcast relay engine runs for helper addresses: the counters stay 0.
      return L(
        servers.flatMap(([n]) => [
          n,
          "-----------",
          "",
          "  Packets received                         : 0",
          "  Packets relayed                          : 0",
          "  Packets dropped                          : 0",
          "  Invalid TTL packets                      : 0",
          "  All ones broadcast packets received      : 0",
          "  Net directed broadcast packets received  : 0",
          "",
        ]),
      );
    }
    const out = ["Interface    Vrf    Relay Address", "-----------  -----  ---------------"];
    for (const [n, list] of servers) {
      out.push("");
      list.forEach((s, i) => {
        const [vrf, ip] = s.includes("|") ? s.split("|") : ["", s];
        out.push(`  ${(i === 0 ? n : "").padEnd(12)} ${vrf.padEnd(6)} ${ip}`);
      });
      out.push("");
    }
    return L(out);
  },
});

// --- show ip|ipv6 dhcp snooping statistics [detail] (dhcp_snooping.xml:46-70) ---
registerModal({
  id: "klish-show-dhcp-snooping-stats",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if ((a[0] !== "ip" && a[0] !== "ipv6") || a[1] !== "dhcp" || a[2] !== "snooping" || a[3] !== "statistics") return null;
    const v4 = a[0] === "ip";
    // The IPv6 snooping engine is not modelled; its counters are all 0.
    const st = v4 ? peekSnoopState(ctx.device)?.stats : undefined;
    if (a[4] === "detail") {
      const n = (x: number | undefined) => x ?? 0;
      const sum = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((s, x) => s + x, 0);
      const dropped = sum(st?.macFail) + sum(st?.srvUntrusted);
      const rows: [string, number][] = [
        ["Error receiving from DHCP snooping socket", 0],
        ["DHCP message too big", 0],
        ["Illegal source IP address in snooped packet", 0],
        ["Illegal source MAC in snooped packet", 0],
        ["Error sending from DHCP snooping socket", 0],
        ["Number of DHCP messages intercepted", n(st?.rx)],
        ["Number of DHCP messages processed", n(st?.rx)],
        ["Number of DHCP messages filtered", dropped],
        ["Number of DHCP messages forwarded", n(st?.fwd)],
        ["Rx RELEASE or DECLINE from client not in bindings db", 0],
        ["Number of bindings added to bindings table", n(st?.added)],
        ["Number of bindings removed from bindings table", 0],
        ["MAC verification failures/server frames recvd on untrusted ports", dropped],
        ["Number of DHCP messages dropped as static binding exists", 0],
        ["Packets dropped due to no outgoing interface or interface down", 0],
      ];
      return L(["", `      DHCPv${v4 ? 4 : 6} Snooping Detailed Statistics`, "-----------------------------------", ...rows.map(([k, v]) => `  ${k.padEnd(64)} : ${v}`), ""]);
    }
    const ports = ctx.device.interfaces
      .filter((i) => !i.management && !i.name.includes(".") && (/^Ethernet\d/.test(i.name) || /^PortChannel\d/.test(i.name)))
      .map((i) => i.name)
      .sort(natural);
    const out = ["", "Interface        MAC Verify   Client Ifc   DHCP Server", "                 Failures     Mismatch     Msgs Recvd", "---------------  ----------   ----------   -----------"];
    for (const p of ports) out.push(`${p.padEnd(15)}  ${String(st?.macFail[p] ?? 0).padEnd(10)}   ${"0".padEnd(10)}   ${String(st?.srvUntrusted[p] ?? 0).padEnd(11)}`);
    return L(out);
  },
});

// --- BFD profiles (bfd.xml:348-372 config, :228 show) ---------------------------
interface BfdProfile {
  name: string;
  enabled: boolean;
  tx: number;
  rx: number;
  mult: number;
  passive: boolean;
  echo: boolean;
}
const profiles = (dev: Device) => featureState<{ list: BfdProfile[] }>(dev, "bfd-profiles", () => ({ list: [] })).list;

// configure-bfd-view: `profile <name>` creates the profile + enters its sub-view; `no profile <name>` deletes it.
registerModal({
  id: "bfd-profile-enter",
  views: ["configure-bfd-view"],
  keywords: ["profile"],
  run({ isNo, args, ctx }) {
    const name = args[0];
    if (!name) return null;
    const list = profiles(ctx.device);
    const i = list.findIndex((p) => p.name === name);
    if (isNo) {
      if (i >= 0) list.splice(i, 1);
      return { output: [] };
    }
    if (i < 0) list.push({ name, enabled: true, tx: 300, rx: 300, mult: 3, passive: false, echo: false });
    return { output: [], enter: subViewFrame("configure-bfd-profile-view", name) };
  },
});

// configure-bfd-profile-view: the profile parameters (defaults: 300 ms / 300 ms / 3, active, echo off).
registerModal({
  id: "bfd-profile",
  views: ["configure-bfd-profile-view"],
  keywords: ["detect-multiplier", "receive-interval", "transmit-interval", "passive-mode", "echo-mode", "shutdown"],
  run({ head, isNo, args, ctx, viewctx, raw }) {
    const p = profiles(ctx.device).find((x) => x.name === viewctx);
    if (!p) return null;
    const n = Number(args[0]);
    if (head === "detect-multiplier") p.mult = isNo || !n ? 3 : n;
    else if (head === "receive-interval") p.rx = isNo || !n ? 300 : n;
    else if (head === "transmit-interval") p.tx = isNo || !n ? 300 : n;
    else if (head === "passive-mode") p.passive = !isNo;
    else if (head === "echo-mode") p.echo = !isNo;
    else p.enabled = isNo;
    cpStoreLine(ctx.device, "bfd-profile", raw, isNo); // keep the line in the generic store, as before
    return { output: [] };
  },
});

registerModal({
  id: "klish-show-bfd-profile",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "bfd" || args[1]?.toLowerCase() !== "profile" || args.length > 3) return null;
    const name = args[2] && args[2] !== "all" ? args[2] : undefined;
    const all = peekFeatureState<{ list: BfdProfile[] }>(ctx.device, "bfd-profiles")?.list ?? [];
    // sonic_cli_bfd_show.py show_bfd_profile: empty list → "No BFD profiles configured";
    // an unknown name renders the template on an empty set (prints nothing).
    if (!all.length) return L(["No BFD profiles configured"]);
    const list = all.filter((p) => !name || p.name === name);
    if (!list.length) return L([]);
    const sep = "------------------------------------------------------------------------------------";
    const yn = (b: boolean) => (b ? "Yes" : "No");
    return L([
      sep,
      "Profile Name      Enabled  TxInterval  RxInterval  Multiplier  Passive  Echo",
      sep,
      ...list.map((p) => `${p.name.slice(0, 17).padEnd(17)} ${yn(p.enabled).padEnd(8)} ${`${p.tx}ms`.padEnd(11)} ${`${p.rx}ms`.padEnd(11)} ${String(p.mult).padEnd(11)} ${yn(p.passive).padEnd(8)} ${yn(p.echo).padEnd(5)}`),
      sep,
      `Total: ${list.length} profile(s)`,
    ]);
  },
});

// --- show bgp all / show bgp ipv4|ipv6 ... vrf / ext-community-list -------------
registerModal({
  id: "klish-show-bgp-forms",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx, delegate }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] !== "bgp") return null;

    // show bgp all [vrf <v>] neighbors [<ip> | interface <type> <id>] | peer-group [<name>]
    if (a[1] === "all") {
      let i = 2;
      let vrf = "default";
      if (a[i] === "vrf") {
        vrf = args[i + 1] ?? "default";
        i += 2;
      }
      if (a[i] === "neighbors") {
        const target = a[i + 1] === "interface" ? ifName(args.slice(i + 2)) : args[i + 1];
        return { output: delegate(`show bgp vrf ${vrf} neighbors${target ? ` ${target}` : ""}`) };
      }
      // Peer-groups are not modelled by the BGP engine: nothing to list.
      if (a[i] === "peer-group") return { output: [] };
      return null;
    }

    // show bgp ipv4|ipv6 [unicast] vrf <name>|all <rest>
    if (a[1] === "ipv4" || a[1] === "ipv6") {
      let i = a[2] === "unicast" ? 3 : 2;
      if (a[i] !== "vrf" || !args[i + 1]) return null;
      const vrf = args[i + 1];
      i += 2;
      const rest = args.slice(i).join(" ");
      if (vrf.toLowerCase() !== "all") return { output: delegate(`show bgp vrf ${vrf} ${a[1]} unicast ${rest}`.trim()) };
      // bgp_show_all_instances_*: one block per BGP instance ("Instance default:").
      const vrfs = ["default", ...bgpVrfNames(ctx.device).sort(natural)];
      return { output: vrfs.flatMap((v) => [line(""), line(`Instance ${v}:`), ...delegate(`show bgp vrf ${v} ${a[1]} unicast ${rest}`.trim())]) };
    }

    // show bgp ext-community-list [<name>] — stored `bgp extcommunity-list standard|expanded <name> permit|deny ...`
    if (a[1] === "ext-community-list" && a.length <= 3) {
      const lists = new Map<string, { expanded: boolean; match: string; entries: string[] }>();
      for (const l of cpRunningLines(ctx.device)) {
        const t = l.line.split(/\s+/);
        if (l.ctx !== "config" || t[0] !== "bgp" || t[1] !== "extcommunity-list" || !t[3]) continue;
        const expanded = t[2] === "expanded";
        let body = t.slice(5);
        let match = "ANY";
        if (body[body.length - 1] === "all" || body[body.length - 1] === "any") match = body.pop()!.toUpperCase();
        // show_bgp_extcom.j2: route-target → "rt:<v>", route-origin → "soo:<v>"
        if (!expanded && (body[0] === "rt" || body[0] === "soo")) body = [`${body[0]}:${body[1]}`];
        const cur = lists.get(t[3]) ?? { expanded, match, entries: [] };
        cur.match = match;
        cur.entries.push(`${t[4]} ${body.join(" ")}`);
        lists.set(t[3], cur);
      }
      const out: string[] = [];
      for (const [name, l] of [...lists].filter(([n]) => !args[2] || n === args[2])) {
        out.push(`${l.expanded ? "Expanded" : "Standard"} extended community list ${name}:  match: ${l.match}`);
        if (l.match === "ALL") out.push(`     ${l.entries[0].split(" ")[0]} ${l.entries.map((e) => e.split(" ").slice(1).join(" ")).join(",")}`);
        else out.push(...l.entries.map((e) => `     ${e}`));
      }
      return L(out);
    }
    return null;
  },
});
