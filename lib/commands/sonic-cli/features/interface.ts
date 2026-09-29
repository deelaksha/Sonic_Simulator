/**
 * Interface modal behaviour (reference feature). configure-if-view (physical) +
 * configure-vlan-view (SVI):
 *   switchport access Vlan <id>            access (untagged) membership
 *   switchport trunk allowed Vlan [add|remove] <list>   trunk (tagged) membership
 *   shutdown | no shutdown                 admin state
 *   ip address <A.B.C.D/M>                 L3 address
 * Delegates to the tested Click `config vlan member` / `config interface ...`.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { expandVlanSpec } from "../util";

registerModal({
  id: "interface",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view", "configure-lo-view"],
  keywords: ["switchport", "shutdown", "ip", "mtu", "description", "speed", "mac"],
  run({ head, isNo, args, ifname, delegate }) {
    const name = ifname ?? "";
    const isVlan = name.startsWith("Vlan");

    if (head === "shutdown") {
      if (isVlan) return { output: [muted("(SVI admin-state is not modelled yet)")] };
      return { output: delegate(`config interface ${isNo ? "startup" : "shutdown"} ${name}`) };
    }

    if (head === "switchport") {
      if (isVlan) return { output: [err("% switchport is only valid on physical interfaces.")] };
      const sub = args[0]?.toLowerCase();
      if (sub === "access" && args[1]?.toLowerCase() === "vlan") {
        const id = args[2];
        if (!id) return { output: [err("% VLAN id required.")] };
        return { output: delegate(`config vlan member ${isNo ? `del ${id}` : `add -u ${id}`} ${name}`) };
      }
      if (sub === "trunk" && args[1]?.toLowerCase() === "allowed" && args[2]?.toLowerCase() === "vlan") {
        let op = args[3]?.toLowerCase();
        let listStr = args[4];
        if (op !== "add" && op !== "remove") {
          listStr = args[3];
          op = isNo ? "remove" : "add";
        }
        const ids = expandVlanSpec(listStr ?? "");
        if (!ids) return { output: [err(`% Invalid VLAN list "${listStr ?? ""}".`)] };
        return { output: ids.flatMap((id) => delegate(`config vlan member ${op === "remove" ? "del" : "add"} ${id} ${name}`)) };
      }
      return { output: [err("% Unrecognized switchport command.")] };
    }

    if (head === "ip" && args[0]?.toLowerCase() === "address") {
      if (!args[1]) return { output: [err("% IP address required.")] };
      return { output: delegate(`config interface ip ${isNo ? "del" : "add"} ${name} ${args[1]}`) };
    }

    if (["mtu", "description", "speed", "mac"].includes(head)) {
      return { output: [muted(`(${head} is not modelled yet)`)] };
    }
    return null;
  },
});

// enable-view: `show ip interface[s]` — device-format table of interfaces with IPs
// (includes logical SVI/Loopback/PortChannel + eth0 mgmt).
registerModal({
  id: "interface-ip-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a1 = args[1]?.toLowerCase();
    if (args[0]?.toLowerCase() !== "ip" || (a1 !== "interface" && a1 !== "interfaces")) return null;
    const rows = ctx.device.interfaces.filter((i) => i.ipv4.length > 0);
    if (!rows.length) return { output: [muted("No IPv4 interfaces configured")] };
    // Column layout matches the real device's `show ip interface`.
    const out = [
      line("Interface    IPv4 address/mask    Master    Admin/Oper    BGP Neighbor    Neighbor IP    Flags"),
      line("-----------  -------------------  --------  ------------  --------------  -------------  -------"),
    ];
    for (const i of rows) {
      const ip = `${i.ipv4[0].address}/${i.ipv4[0].prefix}`;
      out.push(
        line(
          `${i.name.padEnd(11)}  ${ip.padEnd(19)}  ${"".padEnd(8)}  ${`${i.adminState}/${i.operState}`.padEnd(12)}  ${"N/A".padEnd(14)}  ${"N/A".padEnd(13)}`,
        ),
      );
      // secondary IPs on their own rows (as the device does)
      for (const a of i.ipv4.slice(1)) {
        out.push(line(`${"".padEnd(11)}  ${`${a.address}/${a.prefix}`.padEnd(19)}  ${"".padEnd(8)}  ${"".padEnd(12)}  ${"".padEnd(14)}  ${"".padEnd(13)}`));
      }
    }
    return { output: out };
  },
});
