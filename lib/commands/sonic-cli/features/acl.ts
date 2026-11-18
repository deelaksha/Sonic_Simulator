/**
 * ACL modal behaviour (SONiC KLISH, sonic-mgmt-framework acl.xml).
 *
 * sonic(config)# ip access-list ipacl-example      -> create the table + enter sub-view
 * sonic(config-ipv4-acl)# remark <text>            -> ACL description (no remark clears)
 * sonic(config-ipv4-acl)# seq 10 permit ip host 10.1.1.1 host 20.1.1.1 [remark <text>]
 * sonic(config-ipv4-acl)# no seq 10
 * sonic(config)# no ip access-list ipacl-example   -> delete the table (cascades rules)
 *
 * Binding (acl.xml:302-877): `[no] {ip|ipv6|mac} access-group <name> {in|out}`
 *   configure-if-view  (Ethernet)   configure-lag-view (PortChannel)
 *   configure-vlan-view (Vlan)      configure-view     ("Switch", global)
 * `line vty` (control-plane) bindings are accepted by the generic config-plane
 * store but not enforced (no caclmgrd in the simulator).
 *
 * Show / clear (enable-view):
 *   show {ip|ipv6|mac} access-lists [name]   show_access_list.j2
 *   show [ip|ipv6|mac] access-group          show_access_group.j2
 *   clear {ip|ipv6|mac} access-list counters [name]   (device grammar, 4.5.0)
 *
 * Table/rule create/delete delegate to the Click `config acl ...` commands;
 * bindings/shows call the exported helpers of lib/commands/sonic/acl.ts.
 */
import { err } from "../../types";
import { registerModal, MODAL_HANDLERS, ModalHandler } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import { aclBind, aclClearCounters, aclRemark, aclUnbind, renderAccessGroups, renderAccessLists } from "../../sonic/acl";
import { AclType } from "../../../protocols/acl-rules";

// entry keyword -> Click type token + the sub-view it enters.
const ACL_KIND: Record<string, { type: AclType; view: string }> = {
  ip: { type: "ip", view: "configure-ipv4-acl-view" },
  ipv6: { type: "ipv6", view: "configure-ipv6-acl-view" },
  mac: { type: "mac", view: "configure-mac-acl-view" },
};

// configure-view: `[no] {ip|ipv6|mac} access-list <name>` — create/delete + enter sub-view.
registerModal({
  id: "acl-enter",
  views: ["configure-view"],
  keywords: ["ip", "ipv6", "mac"],
  run({ head, isNo, args, delegate }) {
    // Only claim `... access-list ...`; `ip route`, `ip prefix-list`, etc. are not ours.
    if (args[0]?.toLowerCase() !== "access-list") return null;
    const kind = ACL_KIND[head];
    const name = args[1];
    if (!name) return { output: [err("% ACL name required.")] };
    if (isNo) return { output: delegate(`config acl table del ${name}`) };
    return { output: delegate(`config acl table add ${name} ${kind.type}`), enter: subViewFrame(kind.view, name) };
  },
});

// {ipv4|ipv6|mac}-acl sub-views: `seq <n> <permit|deny> <match...>` / `no seq <n>` / `[no] remark`.
registerModal({
  id: "acl",
  views: ["configure-ipv4-acl-view", "configure-ipv6-acl-view", "configure-mac-acl-view"],
  keywords: ["seq", "remark"],
  run({ head, isNo, args, viewctx, ctx, delegate }) {
    const table = viewctx ?? "";
    if (head === "remark") {
      if (!isNo && !args.length) return { output: [err("% remark text required.")] };
      aclRemark(ctx.device, table, isNo ? undefined : args.join(" "));
      return { output: [] };
    }
    const seq = args[0];
    if (!seq) return { output: [err("% sequence number required.")] };
    if (isNo) return { output: delegate(`config acl rule del ${table} ${seq}`) };
    // args already carry `<seq> <permit|deny> <match...>`; Click owns validation/storage.
    return { output: delegate(`config acl rule add ${table} ${args.join(" ")}`) };
  },
});

// `[no] {ip|ipv6|mac} access-group <name> {in|out}` on interfaces / PortChannels / VLANs / globally.
const BIND_VIEWS = ["configure-if-view", "configure-lag-view", "configure-vlan-view", "configure-view"];
const bindHandler: ModalHandler = {
  id: "acl-bind",
  views: BIND_VIEWS,
  keywords: ["ip", "ipv6", "mac"],
  run({ head, isNo, args, ifname, view, ctx }) {
    if (args[0]?.toLowerCase() !== "access-group") return null;
    const name = args[1];
    const dir = args[2]?.toLowerCase();
    if (!name || (dir !== "in" && dir !== "out")) return { output: [err("% Usage: [no] {ip|ipv6|mac} access-group <name> {in|out}")] };
    const port = view === "configure-view" ? "Switch" : ifname ?? "";
    const stage = dir === "in" ? "ingress" : "egress";
    if (isNo) {
      aclUnbind(ctx.device, name, port, stage);
      return { output: [] };
    }
    const e = aclBind(ctx.device, name, port, stage, ACL_KIND[head].type);
    return { output: e ? [err(`%Error: ${e}`)] : [] };
  },
};
// The interface handler (registered earlier) claims `mac` in if-views and would
// swallow `mac access-group`; the bind handler only claims `access-group`, so
// it runs first.
MODAL_HANDLERS.unshift(bindHandler);

// enable-view shows.
registerModal({
  id: "acl-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] === "access-group" && a.length === 1) return { output: renderAccessGroups(ctx.device) };
    const kind = ACL_KIND[a[0]];
    if (!kind) return null;
    if (a[1] === "access-group" && a.length === 2) return { output: renderAccessGroups(ctx.device, kind.type) };
    if (a[1] === "access-lists" && a.length <= 3) return { output: renderAccessLists(ctx.device, kind.type, args[2]) };
    return null; // interface / Switch filters: not modelled
  },
});

registerModal({
  id: "acl-clear",
  views: ["enable-view"],
  keywords: ["clear"],
  run({ args, ctx }) {
    const kind = ACL_KIND[args[0]?.toLowerCase()];
    if (!kind || args[1]?.toLowerCase() !== "access-list" || args[2]?.toLowerCase() !== "counters" || args.length > 4) return null;
    aclClearCounters(ctx.device, kind.type, args[3]);
    return { output: [] };
  },
});
