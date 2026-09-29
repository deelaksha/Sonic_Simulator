/**
 * Management-interface DHCP — CONFIG-PLANE feature (no engine backend).
 *
 *   sonic# renew dhcp-lease interface Management <id>
 *
 * The real box's `mgmt_dhcp` module (data/device-capture/klish-xml/mgmt_dhcp.xml)
 * exposes EXACTLY ONE command: an enable-view RPC that asks the DHCP client to
 * renew the lease on a management interface
 * (sonic-cli-mgmt-dhcp.py rpc_sonic_mgmt_interface_renew_dhcp_lease ${Management}).
 * There is NO configure-view config, NO `show` command, and no `no` form on the
 * box — so nothing from CONFIG_DB is read back for this feature.
 *
 * DATA-PLANE NOT SIMULATED: actually renewing a DHCP lease needs a DHCP client
 * plus a reachable server on the management network, neither of which this lab
 * models. We therefore never fabricate a lease, IP, timers or any operational
 * state. We only record the operator's renewal REQUEST (which management
 * interface was asked to renew) so the requested action can be reflected back
 * honestly — nothing more.
 *
 * REACHABILITY: the core sonic-cli routes only `show` (plus the configure / if /
 * generic sub-views) to modal handlers — enable-view action verbs like `renew`
 * are not dispatched today (see lib/commands/sonic-cli.ts; the same limitation is
 * documented for `clear ip mroute` in features/mroute.ts). Wiring `renew` through
 * the core is a shared-file change that is out of scope for a single feature
 * file, so this handler carries the correct semantics for when that routing is
 * added, and the current user-visible behaviour remains the grammar's
 * "recognized command; behaviour not yet cloned" note.
 */
import { err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove } from "../config-plane";

const ID = "mgmt_dhcp";

// enable-view: `renew dhcp-lease interface Management <id>`.
registerModal({
  id: "mgmt_dhcp",
  views: ["enable-view"],
  keywords: ["renew"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "dhcp-lease") return null; // not ours (other `renew ...` verbs)
    if (args[1]?.toLowerCase() !== "interface")
      return { output: [err("% Usage: renew dhcp-lease interface Management <id>")] };
    if (args[2]?.toLowerCase() !== "management")
      return { output: [err("% Only management interfaces support DHCP-lease renewal")] };
    const id = args[3];
    if (id === undefined || !/^\d+$/.test(id))
      return { output: [err("% A numeric management interface id is required (e.g. Management 0)")] };

    const iface = `Management ${id}`;
    if (isNo) {
      cpRemove(ctx.device, ID, "renewals", "interface", iface);
      return { output: [] };
    }
    // Record the requested renewal only (no lease/IP is invented; the actual
    // lease acquisition is a data-plane action not simulated in this lab).
    cpUpsert(ctx.device, ID, "renewals", { interface: iface }, "interface");
    return {
      output: [
        muted(`% DHCP-lease renewal requested on ${iface}; the lease acquisition (data-plane) is not simulated in this lab.`),
      ],
    };
  },
});
