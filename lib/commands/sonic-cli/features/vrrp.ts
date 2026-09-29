/**
 * VRRP modal behaviour (dedicated SUB-MODE, entered from an interface view).
 *
 *   sonic(config)# interface Ethernet 0
 *   sonic(config-if-Ethernet0)# vrrp 1 address-family ipv4   -> creates + enters sub-view
 *   sonic(config-if--vrrp-ipv4)# priority 120
 *   sonic(config-if--vrrp-ipv4)# vip 40.0.0.5
 *   sonic(config-if--vrrp-ipv4)# version 3
 *   sonic(config-if--vrrp-ipv4)# preempt | no preempt
 *   sonic(config-if--vrrp-ipv4)# exit
 *   sonic(config-if-Ethernet0)# no vrrp 1 address-family ipv4   -> deletes
 *
 * KLISH keys the instance by (iface, vrid), so both are carried in the sub-view
 * ctx string ("<iface> <vrid>") and split back out to build the flat Click paths.
 * Every effect delegates to the tested Click `config vrrp ...` (lib/commands/sonic/
 * vrrp.ts) — nothing is duplicated or faked. That module is IPv4 config-plane only,
 * so only the IPv4 commands it supports are wired here (see the file's exports).
 */
import { err, muted } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";

// Interface view -> the IPv4 VRRP sub-view it enters (grammar view names).
const ENTRY_SUBVIEW: Record<string, string> = {
  "configure-if-view": "configure-vrrp-if-ipv4-view",
  "configure-vlan-view": "configure-vrrp-vlan-ipv4-view",
  "configure-lag-view": "configure-vrrp-lag-ipv4-view",
};

// Interface views: `vrrp <vrid> address-family ipv4` creates the instance and
// drops into the VRRP sub-view; `no vrrp <vrid> ...` deletes it (stays in-view).
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
      return { output: [muted("% IPv6 VRRP is recognized but not modelled in this lab (config-plane, IPv4 only).")] };
    }
    const target = ENTRY_SUBVIEW[view] ?? "configure-vrrp-if-ipv4-view";
    return { output: delegate(`config vrrp add ${iface} ${vrid}`), enter: subViewFrame(target, `${iface} ${vrid}`) };
  },
});

// IPv4 VRRP sub-view: the per-instance attributes the Click module supports.
registerModal({
  id: "vrrp",
  views: ["configure-vrrp-if-ipv4-view", "configure-vrrp-vlan-ipv4-view", "configure-vrrp-lag-ipv4-view"],
  keywords: ["preempt", "priority", "vip", "version"],
  run({ head, isNo, args, viewctx, delegate }) {
    const [iface, vrid] = (viewctx ?? "").split(/\s+/);
    if (!iface || !vrid) return null;

    if (head === "preempt") {
      return { output: delegate(`config vrrp preempt ${iface} ${vrid} ${isNo ? "disable" : "enable"}`) };
    }
    if (head === "priority") {
      if (isNo || !args[0]) return null; // `no priority` (reset to default) not supported by Click
      return { output: delegate(`config vrrp priority ${iface} ${vrid} ${args[0]}`) };
    }
    if (head === "vip") {
      if (isNo || !args[0]) return null; // `no vip <ip>` (remove) not supported by Click
      return { output: delegate(`config vrrp vip ${iface} ${vrid} ${args[0]}`) };
    }
    if (head === "version") {
      if (isNo || !args[0]) return null; // `no version` (reset to default) not supported by Click
      return { output: delegate(`config vrrp version ${iface} ${vrid} ${args[0]}`) };
    }
    return null;
  },
});
