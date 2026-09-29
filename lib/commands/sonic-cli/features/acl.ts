/**
 * ACL modal behaviour (SONiC KLISH SUB-MODE cloning, acl.xml).
 *
 * sonic(config)# ip access-list ipacl-example      -> create the table + enter sub-view
 * sonic(config-ipv4-acl)# seq 10 permit ip host 10.1.1.1 host 20.1.1.1
 * sonic(config-ipv4-acl)# no seq 10
 * sonic(config)# no ip access-list ipacl-example   -> delete the table (cascades rules)
 *
 * `{ip|ipv6|mac} access-list <name>` in configure-view creates the ACL table and
 * drops into the matching dedicated sub-view (configure-ipv4-acl-view /
 * configure-ipv6-acl-view / configure-mac-acl-view), where `seq <n> ...` adds
 * rules. The entry runs its effect via the tested Click `config acl table add`
 * AND enters the sub-view (`enter: subViewFrame(...)`); in the sub-view `seq`
 * delegates to the tested Click `config acl rule add/del`. viewctx carries the
 * ACL name into the sub-view. Behaviour/output is delegated, never duplicated.
 */
import { err } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";

// entry keyword -> Click type token + the sub-view it enters.
const ACL_KIND: Record<string, { type: string; view: string }> = {
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

// {ipv4|ipv6|mac}-acl sub-views: `seq <n> <permit|deny> <match...>` / `no seq <n>`.
registerModal({
  id: "acl",
  views: ["configure-ipv4-acl-view", "configure-ipv6-acl-view", "configure-mac-acl-view"],
  keywords: ["seq"],
  run({ isNo, args, viewctx, delegate }) {
    const table = viewctx ?? "";
    const seq = args[0];
    if (!seq) return { output: [err("% sequence number required.")] };
    if (isNo) return { output: delegate(`config acl rule del ${table} ${seq}`) };
    // args already carry `<seq> <permit|deny> <match...>`; Click owns validation/storage.
    return { output: delegate(`config acl rule add ${table} ${args.join(" ")}`) };
  },
});
