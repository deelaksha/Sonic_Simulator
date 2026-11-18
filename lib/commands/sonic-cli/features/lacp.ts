/**
 * LACP / PortChannel KLISH behaviour (sonic-mgmt-framework interface.xml):
 *
 *   sonic(config)# interface PortChannel <id>          (core: creates the PortChannel)
 *   sonic(conf-if-po1)# min-links <1-1024> | no min-links      interface.xml:1533-1550
 *   sonic(conf-if-po1)# fallback | no fallback                 interface.xml:1469-1499
 *   sonic(conf-if-po1)# fast_rate | no fast_rate               interface.xml:1501-1531
 *   sonic(config-if-Ethernet0)# channel-group <id>     -> join PortChannel<id>   interface.xml:681
 *   sonic(config-if-Ethernet0)# no channel-group       -> leave its PortChannel  interface.xml:698
 *   sonic# show PortChannel summary                    show_portchannel.j2 (sonic_cli_portchannel.py)
 *   sonic# show interface PortChannel <id>             show_portchannel_detail.j2 (show_portchannel.py)
 *
 * Membership delegates to the Click `config portchannel member add/del`. The
 * lag-view settings write the PORTCHANNEL row directly (the Click CLI has no
 * post-create update); the teamd runner picks them up on its next tick (real
 * teammgrd only applies min_links/fallback at LAG creation, teammgr.cpp:259 —
 * the simulator applies them live).
 *
 * Not wired: the single-line `interface PortChannel 1 min-links 2 fallback fast_rate`
 * form (the core `interface` parser in sonic-cli.ts only accepts the name).
 */
import { OutputLine, err, line } from "../../types";
import { registerModal } from "../registry";
import { peekFeatureState } from "../../../models/feature-state";
import { Device, interfaceByName } from "../../../models/device";
import { NetInterface } from "../../../models/interface";
import { lagEntry, lagId, LacpState, MIN_LINKS } from "../../sonic/lacp";
import { lacpRuntime, lagConfigs } from "../../../protocols/lacp-daemon";

registerModal({
  id: "lacp",
  views: ["configure-if-view"],
  keywords: ["channel-group"],
  run({ ctx, ifname, isNo, args, delegate }) {
    const iface = ifname ?? "";
    if (isNo) {
      const owner = peekFeatureState<LacpState>(ctx.device, "lacp")?.portchannels.find((p) => p.members.includes(iface));
      if (!owner) return { output: [err(`% ${iface} is not a member of any PortChannel.`)] };
      return { output: delegate(`config portchannel member del ${owner.name} ${iface}`) };
    }
    const id = args[0];
    if (!id) return { output: [err("% PortChannel number required.")] };
    return { output: delegate(`config portchannel member add PortChannel${id} ${iface}`) };
  },
});

registerModal({
  id: "lacp-lag",
  views: ["configure-lag-view"],
  keywords: ["min-links", "fallback", "fast_rate"],
  run({ ctx, ifname, isNo, head, args }) {
    const pc = lagEntry(ctx.device, ifname ?? "");
    if (!pc) return { output: [err(`% ${ifname} does not exist.`)] };
    if (head === "min-links") {
      if (isNo) {
        pc.minLinks = 1; // interface.xml:1455 resets to 1
        return { output: [] };
      }
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < MIN_LINKS.min || n > MIN_LINKS.max) {
        return { output: [err(`% Invalid min-links "${args[0] ?? ""}" (range ${MIN_LINKS.min}-${MIN_LINKS.max}).`)] };
      }
      pc.minLinks = n;
      return { output: [] };
    }
    if (head === "fallback") pc.fallback = !isNo;
    else pc.fastRate = !isNo;
    return { output: [] };
  },
});

// ---------- show ----------

const DASH = "-".repeat(124);
const fmt = (...cols: [string, number][]) => cols.map(([s, w]) => s.padEnd(w)).join("");

/** show_portchannel.j2 + sonic_cli_portchannel.py member status (UP→P, DOWN→D). */
function showSummary(d: Device): OutputLine[] {
  const out: OutputLine[] = [
    line("Flags(oper-status):  D - Down U - Up (portchannel) P - Up in portchannel (members) I - LACP individual"),
    line(DASH),
    line(fmt(["Group", 10], ["PortChannel", 20], ["Type", 15], ["Protocol", 15], ["Member Ports", 25])),
    line(DASH),
    line(""),
  ];
  const lags = lagConfigs(d).sort((a, b) => (lagId(a.name) ?? 0) - (lagId(b.name) ?? 0));
  if (!lags.length) return [...out, line("No PortChannels configured")];
  const rt = lacpRuntime(d);
  for (const lag of lags) {
    const oper = interfaceByName(d, lag.name)?.operState === "up" ? "U" : "D";
    const members = lag.members.map((m) => `${m}(${rt?.lags[lag.name]?.ports[m]?.enabled ? "P" : "D"})`).join(", ");
    out.push(line(fmt([lag.name.replace("PortChannel", ""), 10], [lag.name, 20], [`Eth (${oper})`, 15], ["LACP", 15], [members, 25])));
  }
  return out;
}

/** show_portchannel.py _fmt_line_speed. */
function lineSpeed(mbps: number): string {
  if (!mbps) return "0M";
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(1)}G` : `${Math.trunc(mbps)}M`;
}

/** show_portchannel_detail.j2 rendered from live interface + teamd state. */
function showDetail(d: Device, name: string): OutputLine[] {
  const pc = interfaceByName(d, name);
  const lag = lagConfigs(d).find((l) => l.name === name);
  if (!pc || !lag) return [err(`% Interface ${name} not found`)];
  const lr = lacpRuntime(d)?.lags[name];
  const mac = pc.mac.toLowerCase();
  const out: string[] = [
    `${name} is ${pc.adminState}, line protocol is ${pc.operState}, mode LACP`,
    `Hardware is PortChannel, address is ${mac}`,
    `Minimum number of links to bring PortChannel up is ${lag.minLinks ?? 1}`,
  ];
  if (pc.ipv4.length) out.push(`IPV4 address is ${pc.ipv4.map((a) => `${a.address}/${a.prefix}`).join(",")}`);
  out.push(`Mode of IPV4 address assignment: ${pc.ipv4.length ? "STATIC" : "not-set"}`);
  out.push("Mode of IPV6 address assignment: not-set");
  out.push(`Fallback: ${lag.fallback ? "Enabled" : "Disabled"}`);
  out.push("MTU 9100");
  const members = lag.members.filter((m) => interfaceByName(d, m));
  out.push(`LineSpeed ${lineSpeed(members.reduce((s, m) => s + (interfaceByName(d, m)?.speed ?? 0), 0))}`);
  out.push(`LACP mode ACTIVE interval ${lag.fastRate ? "FAST" : "SLOW"} priority 65535 address ${mac}`);
  if (members.length) {
    out.push(`Members in this channel: ${members.join(" ")}`);
    for (const m of members) {
      const p = lr?.ports[m];
      if (!p) continue;
      out.push(`LACP Actor port ${p.actor.port}  address ${p.actor.system.toLowerCase()} key ${p.actor.key}`);
      out.push(`LACP Partner port ${p.partner.port}  address ${p.partner.system.toLowerCase()} key ${p.partner.key}`);
    }
    const sum = (f: (s: NetInterface["statistics"]) => number) => members.reduce((s, m) => s + f(interfaceByName(d, m)!.statistics), 0);
    const inB = sum((s) => s.rxBroadcast ?? 0);
    const inM = sum((s) => s.rxMulticast ?? 0);
    const outB = sum((s) => s.txBroadcast ?? 0);
    const outM = sum((s) => s.txMulticast ?? 0);
    const inP = sum((s) => s.rxFrames);
    const outP = sum((s) => s.txFrames);
    out.push(
      'Last clearing of "show interface" counters: never',
      "10 seconds input rate 0 packets/sec, 0 bits/sec, 0 Bytes/sec",
      "10 seconds output rate 0 packets/sec, 0 bits/sec, 0 Bytes/sec",
      "Input statistics:",
      `          ${inP} packets, ${sum((s) => s.rxBytes)} octets`,
      `          ${inM} Multicasts, ${inB} Broadcasts, ${inP - inM - inB} Unicasts`,
      `          0 error, ${sum((s) => s.rxDropped)} discarded`,
      "Output statistics:",
      `          ${outP} packets, ${sum((s) => s.txBytes)} octets`,
      `          ${outM} Multicasts, ${outB} Broadcasts, ${outP - outM - outB} Unicasts`,
      `          0 error, ${sum((s) => s.txDropped)} discarded`,
    );
  }
  return out.map((t) => line(t));
}

registerModal({
  id: "lacp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ ctx, args }) {
    const a0 = args[0]?.toLowerCase();
    if (a0 === "portchannel" && (args[1] === undefined || args[1].toLowerCase() === "summary")) {
      return { output: showSummary(ctx.device) };
    }
    if (a0 === "interface" && /^portchannel/i.test(args[1] ?? "")) {
      const id = /^portchannel(\d+)$/i.exec(args[1])?.[1] ?? args[2];
      if (!id || !/^\d+$/.test(id)) return null;
      return { output: showDetail(ctx.device, `PortChannel${id}`) };
    }
    return null;
  },
});

