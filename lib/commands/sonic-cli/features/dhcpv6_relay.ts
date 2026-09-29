/**
 * DHCPv6 relay — CONFIG-PLANE feature (no engine/packet backend, no Click module).
 *
 * Real KLISH (data/device-capture/klish-xml/dhcpv6_relay.xml) puts the config in
 * every per-interface sub-view (configure-if/lag/vlan/subif-view), keyed "ipv6":
 *   ipv6 dhcp-relay <X:X::X> [vrf <name>] [<X:X::X> ...]  add relay server addr(s)
 *   ipv6 dhcp-relay source-interface <intf>               relay source interface
 *   ipv6 dhcp-relay max-hop-count <0..16>                 max relay hop count
 *   ipv6 dhcp-relay vrf-select                            enable VRF selection
 *   no ipv6 dhcp-relay [<X:X::X> ...] | source-interface | max-hop-count | vrf-select
 * and the render in enable-view:
 *   show ipv6 dhcp-relay [brief | detailed [<intf>] | statistics <intf>]
 *
 * There is no data-plane here: the sim does not actually relay DHCPv6 packets, so
 * per-interface config is stored and rendered back honestly, and `statistics`
 * (runtime counters) are reported as not simulated rather than fabricated.
 */
import { line, err, muted, OutputLine } from "../../types";
import { Device } from "../../../models/device";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";

const FEATURE = "dhcpv6_relay";

type RelayEntry = {
  interface: string;
  servers?: string[];
  vrf?: string;
  "source-interface"?: string;
  "max-hop-count"?: number;
  "vrf-select"?: boolean;
};

function entryFor(device: Device, iface: string): RelayEntry | undefined {
  return (cpList(device, FEATURE, "interfaces") as unknown as RelayEntry[]).find((e) => e.interface === iface);
}

function isEmpty(e: RelayEntry): boolean {
  return !(e.servers && e.servers.length) && !e.vrf && !e["source-interface"] && e["max-hop-count"] == null && !e["vrf-select"];
}

/** Merge a patch into the interface's entry; prune the entry when nothing is left. */
function upsert(device: Device, iface: string, patch: Partial<RelayEntry>): void {
  const merged: RelayEntry = { ...(entryFor(device, iface) ?? {}), ...patch, interface: iface };
  if (isEmpty(merged)) cpRemove(device, FEATURE, "interfaces", "interface", iface);
  else cpUpsert(device, FEATURE, "interfaces", merged as Record<string, unknown>, "interface");
}

// configure-{if,lag,vlan,subif}-view: `ipv6 dhcp-relay ...` — store per interface.
registerModal({
  id: "dhcpv6_relay",
  views: ["configure-if-view", "configure-lag-view", "configure-vlan-view", "configure-subif-view"],
  keywords: ["ipv6"],
  run({ isNo, args, ifname, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "dhcp-relay") return null; // not ours (e.g. `ipv6 address`)
    const iface = ifname ?? "";
    const sub = (args[1] ?? "").toLowerCase();

    if (sub === "source-interface") {
      if (isNo) {
        upsert(ctx.device, iface, { "source-interface": undefined });
        return { output: [] };
      }
      const src = args[2];
      if (!src) return { output: [err("% source interface name required.")] };
      upsert(ctx.device, iface, { "source-interface": src });
      return { output: [] };
    }

    if (sub === "max-hop-count") {
      if (isNo) {
        upsert(ctx.device, iface, { "max-hop-count": undefined });
        return { output: [] };
      }
      const n = Number(args[2]);
      if (!Number.isInteger(n) || n < 0 || n > 16) return { output: [err("% max hop count must be an integer in 0..16.")] };
      upsert(ctx.device, iface, { "max-hop-count": n });
      return { output: [] };
    }

    if (sub === "vrf-select") {
      upsert(ctx.device, iface, { "vrf-select": isNo ? undefined : true });
      return { output: [] };
    }

    // Address (server) form: `ipv6 dhcp-relay <addr> [vrf <name>] [<addr> ...]`.
    const rest = args.slice(1);
    const servers: string[] = [];
    let vrf: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].toLowerCase() === "vrf") {
        vrf = rest[++i];
        continue;
      }
      servers.push(rest[i]);
    }

    if (isNo && servers.length === 0) {
      // `no ipv6 dhcp-relay` — clear all relay server addresses (and the server VRF).
      upsert(ctx.device, iface, { servers: [], vrf: undefined });
      return { output: [] };
    }
    if (servers.length === 0) return { output: [err("% DHCPv6 relay server address required.")] };
    const bad = servers.find((s) => !s.includes(":"));
    if (bad) return { output: [err(`% Invalid IPv6 address "${bad}".`)] };

    const current = entryFor(ctx.device, iface)?.servers ?? [];
    if (isNo) {
      upsert(ctx.device, iface, { servers: current.filter((s) => !servers.includes(s)) });
    } else {
      const nextServers = [...current];
      for (const s of servers) if (!nextServers.includes(s)) nextServers.push(s);
      upsert(ctx.device, iface, { servers: nextServers, ...(vrf ? { vrf } : {}) });
    }
    return { output: [] };
  },
});

// enable-view: `show ipv6 dhcp-relay ...` — render only what was configured.
registerModal({
  id: "dhcpv6_relay-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ipv6" || args[1]?.toLowerCase() !== "dhcp-relay") return null; // not ours
    const sub = (args[2] ?? "").toLowerCase();

    if (sub === "statistics") {
      // Statistics are runtime packet counters; the sim has no relay data-plane.
      return { output: [muted("% DHCPv6 relay statistics are runtime counters; not simulated in this lab.")] };
    }

    let entries = (cpList(ctx.device, FEATURE, "interfaces") as unknown as RelayEntry[]).filter((e) => !isEmpty(e));
    if (sub === "detailed" && args[3]) entries = entries.filter((e) => e.interface === args[3]);
    if (entries.length === 0) return { output: [muted("No DHCPv6 relay configured")] };

    const detailed = sub === "detailed";
    const out: OutputLine[] = [];
    for (const e of entries) {
      out.push(line(`Interface: ${e.interface}`));
      out.push(line(`  DHCPv6 Relay Address: ${(e.servers ?? []).join(", ") || "-"}`));
      if (e.vrf) out.push(line(`  Server VRF: ${e.vrf}`));
      if (detailed) {
        if (e["source-interface"]) out.push(line(`  Source Interface: ${e["source-interface"]}`));
        if (e["max-hop-count"] != null) out.push(line(`  Max Hop Count: ${e["max-hop-count"]}`));
        if (e["vrf-select"]) out.push(line("  VRF Selection: enabled"));
      }
    }
    return { output: out };
  },
});
