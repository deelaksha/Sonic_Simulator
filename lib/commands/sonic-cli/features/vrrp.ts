/**
 * VRRP modal behaviour (dedicated SUB-MODE, entered from an interface view).
 *
 *   sonic(config)# interface Vlan 10
 *   sonic(config-if-Vlan10)# vrrp 10 address-family ipv4     -> creates + enters sub-view
 *   sonic(config-if-Vlan10-vrrp-ipv4-10)# vip 192.168.10.1   | no vip 192.168.10.1
 *   ...# priority 120                                         | no priority      (100)
 *   ...# advertisement-interval 1                             | no advertisement-interval (1 s)
 *   ...# version 3                                            | no version       (3)
 *   ...# preempt | no preempt
 *   ...# shutdown | no shutdown        (sonic-mgmt-framework vrrp.xml:456-480, FRR `vrrp N shutdown`)
 *   sonic(config-if-Vlan10)# no vrrp 10 address-family ipv4   -> removes the IPv4 family
 *   sonic(config-if-Vlan10)# no vrrp 10                       -> deletes the instance
 *   sonic(config-if-Vlan10)# vrrp 10 address-family ipv6     -> VRRP6 row + IPv6 sub-view:
 *   ...-vrrp-ipv6-10)# vip 2001:db8::1 | priority | preempt | advertisement-interval
 *     (priority/interval/preempt are the shared FRR router attributes, frrcfgd.py:3580)
 *   ...# track-interface Ethernet 4 weight 30 | no track-interface Ethernet 4   (both families;
 *     a tracked interface that is down lowers the advertised priority by its weight,
 *     lib/protocols/vrrp.ts trackPenalty)
 *
 * Grammar: data/sonic-cli-grammar.json configure-vrrp-*-ipv4-view (advertisement-interval
 * in seconds 1-255, priority 1-254, version 2-3). KLISH keys the instance by
 * (iface, vrid), carried in the sub-view ctx string ("<iface> <vrid>"). Effects
 * delegate to the Click `config interface vrrp ...` commands (lib/commands/sonic/vrrp.ts);
 * `shutdown` has no Click form and writes the instance directly.
 */
import { err } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import { isValidIpv6 } from "../../../models/ipv6";
import { VrrpFamily } from "../../../protocols/vrrp";
import { setVrrpShutdown, setVrrpTrack, addVrrp6, removeVrrpFamily, setVip6 } from "../../sonic/vrrp";
import "./vrrp-show";

// Interface view -> the IPv4 VRRP sub-view it enters (grammar view names).
const ENTRY_SUBVIEW: Record<string, string> = {
  "configure-if-view": "configure-vrrp-if-ipv4-view",
  "configure-vlan-view": "configure-vrrp-vlan-ipv4-view",
  "configure-lag-view": "configure-vrrp-lag-ipv4-view",
};
const v6View = (v4: string) => v4.replace("-ipv4-", "-ipv6-");

/** `track-interface Ethernet 4 weight 30` / `Ethernet4 weight 30` → [ifname, weight]. */
function parseTrack(args: string[]): { ifname: string; weight?: number } | undefined {
  let i = 0;
  let ifname = args[i++] ?? "";
  if (/^[A-Za-z]+$/.test(ifname) && /^\d+(\.\d+)?$/.test(args[i] ?? "")) ifname += args[i++];
  ifname = ifname.replace(/^ethernet/i, "Ethernet").replace(/^portchannel/i, "PortChannel").replace(/^vlan/i, "Vlan").replace(/^loopback/i, "Loopback");
  if (!ifname) return undefined;
  if ((args[i] ?? "").toLowerCase() === "weight") {
    const w = Number(args[i + 1]);
    if (!Number.isInteger(w) || w < 1 || w > 254) return undefined;
    return { ifname, weight: w };
  }
  return { ifname };
}

registerModal({
  id: "vrrp-enter",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["vrrp"],
  run({ ctx, view, ifname, isNo, args, delegate }) {
    const iface = ifname ?? "";
    const vrid = args[0];
    if (!vrid) return { output: [err("% VRRP ID (1-255) required.")] };
    const afiIdx = args.indexOf("address-family");
    const afi = (afiIdx >= 0 ? args[afiIdx + 1] : "ipv4")?.toLowerCase();
    if (isNo) {
      // `address-family ipv4|ipv6` removes just that family (vrrp.xml:256-260).
      if (afiIdx < 0) return { output: delegate(`config vrrp del ${iface} ${vrid}`) };
      removeVrrpFamily(ctx.device, iface, Number(vrid), afi === "ipv6" ? "v6" : "v4");
      return { output: [] };
    }
    const target = ENTRY_SUBVIEW[view] ?? "configure-vrrp-if-ipv4-view";
    if (afi === "ipv6") {
      const n = Number(vrid);
      if (!Number.isInteger(n) || n < 1 || n > 255) return { output: [err("% VRRP ID (1-255) required.")] };
      addVrrp6(ctx.device, iface, n);
      return { output: [], enter: subViewFrame(v6View(target), `${iface} ${vrid}`) };
    }
    return { output: delegate(`config vrrp add ${iface} ${vrid}`), enter: subViewFrame(target, `${iface} ${vrid}`) };
  },
});

registerModal({
  id: "vrrp",
  views: ["configure-vrrp-if-ipv4-view", "configure-vrrp-vlan-ipv4-view", "configure-vrrp-lag-ipv4-view"],
  keywords: ["preempt", "priority", "vip", "version", "advertisement-interval", "shutdown", "track-interface"],
  run({ ctx, head, isNo, args, viewctx, delegate }) {
    const [iface, vrid] = (viewctx ?? "").split(/\s+/);
    if (!iface || !vrid) return null;
    const click = (rest: string) => ({ output: delegate(`config interface vrrp ${rest}`) });

    switch (head) {
      case "preempt":
        return click(`pre_empt ${iface} ${vrid} ${isNo ? "disabled" : "enabled"}`);
      case "priority":
        if (isNo) return click(`priority ${iface} ${vrid} 100`);
        return args[0] ? click(`priority ${iface} ${vrid} ${args[0]}`) : null;
      case "vip":
        if (!args[0]) return null;
        return click(`ip ${isNo ? "remove" : "add"} ${iface} ${vrid} ${args[0]}`);
      case "version":
        if (isNo) return click(`version ${iface} ${vrid} 3`);
        return args[0] ? click(`version ${iface} ${vrid} ${args[0]}`) : null;
      case "advertisement-interval":
        if (isNo) return click(`adv_interval ${iface} ${vrid} 1`);
        return args[0] ? click(`adv_interval ${iface} ${vrid} ${args[0]}`) : null;
      case "shutdown":
        return { output: setVrrpShutdown(ctx.device, iface, Number(vrid), !isNo) };
      case "track-interface":
        return track(ctx.device, iface, Number(vrid), "v4", isNo, args);
    }
    return null;
  },
});

function track(device: Parameters<typeof setVrrpTrack>[0], iface: string, vrid: number, fam: VrrpFamily, isNo: boolean, args: string[]) {
  const t = parseTrack(args);
  if (!t || (!isNo && t.weight === undefined)) return { output: [err("% Usage: track-interface <interface> weight <1-254>")] };
  return { output: setVrrpTrack(device, iface, vrid, fam, t.ifname, isNo ? undefined : t.weight) };
}

// IPv6 sub-view: VIPs are per family; priority/interval/preempt are the shared router attributes.
registerModal({
  id: "vrrp6",
  views: ["configure-vrrp-if-ipv6-view", "configure-vrrp-vlan-ipv6-view", "configure-vrrp-lag-ipv6-view"],
  keywords: ["preempt", "priority", "vip", "advertisement-interval", "track-interface"],
  run({ ctx, head, isNo, args, viewctx, delegate }) {
    const [iface, vrid] = (viewctx ?? "").split(/\s+/);
    if (!iface || !vrid) return null;
    const click = (rest: string) => ({ output: delegate(`config interface vrrp6 ${rest}`) });
    switch (head) {
      case "preempt":
        return click(`pre_empt ${iface} ${vrid} ${isNo ? "disabled" : "enabled"}`);
      case "priority":
        if (isNo) return click(`priority ${iface} ${vrid} 100`);
        return args[0] ? click(`priority ${iface} ${vrid} ${args[0]}`) : null;
      case "advertisement-interval":
        if (isNo) return click(`adv_interval ${iface} ${vrid} 1`);
        return args[0] ? click(`adv_interval ${iface} ${vrid} ${args[0]}`) : null;
      case "vip": {
        const a = (args[0] ?? "").split("/")[0];
        if (!isValidIpv6(a)) return { output: [err(`% Invalid IPv6 address "${args[0] ?? ""}".`)] };
        return { output: setVip6(ctx.device, iface, Number(vrid), a, !isNo) };
      }
      case "track-interface":
        return track(ctx.device, iface, Number(vrid), "v6", isNo, args);
    }
    return null;
  },
});
