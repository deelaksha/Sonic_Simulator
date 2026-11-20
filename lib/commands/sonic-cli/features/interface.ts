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
import { natCompare, tabulateSimple } from "../../sonic/arpnd";
import { vrfOf, DEFAULT_VRF } from "../../../models/vrf";
import { linkLocalFromMac } from "../../../models/ipv6";

registerModal({
  id: "interface",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view", "configure-lo-view"],
  keywords: ["switchport", "shutdown", "ip", "mtu", "description", "speed", "mac"],
  run({ ctx, head, isNo, args, ifname, delegate }) {
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
        // `no switchport access Vlan` takes no id: it DELETEs the port's access-vlan
        // (interface.xml:1059-1062).
        const port = ctx.device.interfaces.find((i) => i.name === name);
        const hybrid = port?.vlan.mode === "trunk" && port.vlan.nativeVlan !== 1 && port.vlan.nativeVlan === port.vlan.accessVlan;
        if (isNo && port?.vlan.mode !== "access" && !hybrid) return { output: [] };
        const id = isNo ? String(port?.vlan.accessVlan ?? "") : args[2];
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

// enable-view: `show ipv6 interfaces` (ipv6.xml:593; there is no `show ipv6 interface brief`).
// Layout of the device capture data/device-capture/show-outputs/show_ipv6_interface.txt:
// tabulate "simple", one row per address, the kernel's EUI-64 link-local listed after the
// global address(es), Master = the VRF the interface is bound to.
registerModal({
  id: "interface-ipv6-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a1 = args[1]?.toLowerCase();
    if (args[0]?.toLowerCase() !== "ipv6" || (a1 !== "interface" && a1 !== "interfaces") || args.length > 2) return null;
    const rows: string[][] = [];
    const ifs = ctx.device.interfaces.filter((i) => i.ipv6.length > 0).sort((a, b) => natCompare(a.name, b.name));
    for (const i of ifs) {
      const addrs = i.ipv6.map((a) => `${a.address}/${a.prefix}`);
      if (!i.ipv6.some((a) => /^fe80:/i.test(a.address))) addrs.push(`${linkLocalFromMac(i.mac)}/64`);
      const vrf = vrfOf(ctx.device, i);
      rows.push([i.name, addrs[0], vrf === DEFAULT_VRF ? "" : vrf, `${i.adminState}/${i.operState}`, "N/A", "N/A", ""]);
      for (const a of addrs.slice(1)) rows.push(["", a, "", "", "", "", ""]);
    }
    const headers = ["Interface", "IPv6 address/mask", "Master", "Admin/Oper", "BGP Neighbor", "Neighbor IP", "Flags"];
    return { output: tabulateSimple(headers, rows).map((t) => line(t)) };
  },
});
