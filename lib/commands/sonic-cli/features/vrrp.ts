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
 *   sonic(config-if-Vlan10)# no vrrp 10 address-family ipv4   -> deletes
 *
 * Grammar: data/sonic-cli-grammar.json configure-vrrp-*-ipv4-view (advertisement-interval
 * in seconds 1-255, priority 1-254, version 2-3). KLISH keys the instance by
 * (iface, vrid), carried in the sub-view ctx string ("<iface> <vrid>"). Effects
 * delegate to the Click `config interface vrrp ...` commands (lib/commands/sonic/vrrp.ts);
 * `shutdown` has no Click form and writes the instance directly.
 * `track-interface` is accepted but has no effect: SONiC's VRRP daemon (FRR vrrpd)
 * has no interface tracking and nothing consumes the VRRP_TRACK table.
 */
import { err, muted } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import { setVrrpShutdown } from "../../sonic/vrrp";
import "./vrrp-show";

// Interface view -> the IPv4 VRRP sub-view it enters (grammar view names).
const ENTRY_SUBVIEW: Record<string, string> = {
  "configure-if-view": "configure-vrrp-if-ipv4-view",
  "configure-vlan-view": "configure-vrrp-vlan-ipv4-view",
  "configure-lag-view": "configure-vrrp-lag-ipv4-view",
};

registerModal({
  id: "vrrp-enter",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["vrrp"],
  run({ view, ifname, isNo, args, delegate }) {
    const iface = ifname ?? "";
    const vrid = args[0];
    if (!vrid) return { output: [err("% VRRP ID (1-255) required.")] };
    if (isNo) return { output: delegate(`config vrrp del ${iface} ${vrid}`) };
    const afiIdx = args.indexOf("address-family");
    const afi = (afiIdx >= 0 ? args[afiIdx + 1] : "ipv4")?.toLowerCase();
    if (afi === "ipv6") {
      return { output: [muted("% IPv6 VRRP is recognized but not modelled in this lab (IPv4 only).")] };
    }
    const target = ENTRY_SUBVIEW[view] ?? "configure-vrrp-if-ipv4-view";
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
        return { output: [muted("% track-interface: accepted, no effect — FRR vrrpd (SONiC's VRRP daemon) has no interface tracking.")] };
    }
    return null;
  },
});
