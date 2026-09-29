/**
 * DHCP (IPv4) relay — CONFIG-PLANE feature (no engine/packet backend, no
 * lib/commands/sonic/dhcp_relay.ts Click module).
 *
 * Real KLISH (data/device-capture/klish-xml/dhcp_relay.xml) puts the config in
 * every per-interface sub-view (configure-if/lag/vlan-view), keyed "ip":
 *   ip dhcp-relay <A.B.C.D> [vrf <name>] [<A.B.C.D> ...]  add relay server addr(s)
 *   ip dhcp-relay source-interface <intf>                 relay source interface
 *   ip dhcp-relay max-hop-count <0..16>                   max relay hop count
 *   ip dhcp-relay policy-action <discard|append|replace>  option-82 policy
 *   ip dhcp-relay circuit-id <format>                     circuit-id format
 *   ip dhcp-relay link-select                             enable link-selection
 *   ip dhcp-relay vrf-select                              enable VRF selection
 *   ip dhcp-relay smart-relay                             enable smart relay
 *   no ip dhcp-relay [<A.B.C.D> ...] | <suboption>        unconfigure
 * and the render in enable-view:
 *   show ip dhcp-relay [brief | detailed [<intf>] | statistics <intf>]
 *
 * State is stored honestly in the config-plane (device.config.features
 * ["cp_dhcp_relay"]) and rendered back on `show`; nothing operational is faked.
 * `statistics` are runtime packet counters, so they are reported as not
 * simulated (there is no relay data-plane) rather than fabricated.
 *
 * NOTE: the older modal `dhcp` feature (features/dhcp.ts) delegates only the
 * IPv4 helper-address subset of `ip dhcp-relay` to the Click `config dhcp-relay`
 * module; this config-plane clone models the full CONFIG_DB (addresses AND the
 * per-interface suboptions that have no Click backend). Whichever handler is
 * registered first claims a given `ip dhcp-relay` line.
 */
import { line, err, muted, OutputLine } from "../../types";
import { Device } from "../../../models/device";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { isValidIpv4 } from "../../../models/ip";

const FEATURE = "dhcp_relay";
const POLICY_ACTIONS = ["discard", "append", "replace"];

type RelayEntry = {
  interface: string;
  servers?: string[];
  vrf?: string;
  "source-interface"?: string;
  "max-hop-count"?: number;
  "policy-action"?: string;
  "circuit-id"?: string;
  "link-select"?: boolean;
  "vrf-select"?: boolean;
  "smart-relay"?: boolean;
};

function entryFor(device: Device, iface: string): RelayEntry | undefined {
  return (cpList(device, FEATURE, "interfaces") as unknown as RelayEntry[]).find((e) => e.interface === iface);
}

function isEmpty(e: RelayEntry): boolean {
  return (
    !(e.servers && e.servers.length) &&
    !e.vrf &&
    !e["source-interface"] &&
    e["max-hop-count"] == null &&
    !e["policy-action"] &&
    !e["circuit-id"] &&
    !e["link-select"] &&
    !e["vrf-select"] &&
    !e["smart-relay"]
  );
}

/** Merge a patch into the interface's entry; prune the entry when nothing is left. */
function upsert(device: Device, iface: string, patch: Partial<RelayEntry>): void {
  const merged: RelayEntry = { ...(entryFor(device, iface) ?? {}), ...patch, interface: iface };
  if (isEmpty(merged)) cpRemove(device, FEATURE, "interfaces", "interface", iface);
  else cpUpsert(device, FEATURE, "interfaces", merged as Record<string, unknown>, "interface");
}

// configure-{if,lag,vlan}-view: `ip dhcp-relay ...` — store per interface.
registerModal({
  id: "dhcp_relay",
  views: ["configure-if-view", "configure-lag-view", "configure-vlan-view"],
  keywords: ["ip"],
  run({ isNo, args, ifname, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "dhcp-relay") return null; // not ours (e.g. `ip address`)
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

    if (sub === "policy-action") {
      if (isNo) {
        upsert(ctx.device, iface, { "policy-action": undefined });
        return { output: [] };
      }
      const action = (args[2] ?? "").toLowerCase();
      if (!POLICY_ACTIONS.includes(action)) return { output: [err(`% policy action must be one of ${POLICY_ACTIONS.join("|")}.`)] };
      upsert(ctx.device, iface, { "policy-action": action });
      return { output: [] };
    }

    if (sub === "circuit-id") {
      if (isNo) {
        upsert(ctx.device, iface, { "circuit-id": undefined });
        return { output: [] };
      }
      const fmt = args[2];
      if (!fmt) return { output: [err("% circuit-id format required.")] };
      upsert(ctx.device, iface, { "circuit-id": fmt });
      return { output: [] };
    }

    if (sub === "link-select") {
      upsert(ctx.device, iface, { "link-select": isNo ? undefined : true });
      return { output: [] };
    }

    if (sub === "vrf-select") {
      upsert(ctx.device, iface, { "vrf-select": isNo ? undefined : true });
      return { output: [] };
    }

    if (sub === "smart-relay") {
      upsert(ctx.device, iface, { "smart-relay": isNo ? undefined : true });
      return { output: [] };
    }

    // Address (server) form: `ip dhcp-relay <A.B.C.D> [vrf <name>] [<A.B.C.D> ...]`.
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
      // `no ip dhcp-relay` — clear all relay server addresses (and the server VRF).
      upsert(ctx.device, iface, { servers: [], vrf: undefined });
      return { output: [] };
    }
    if (servers.length === 0) return { output: [err("% DHCP relay server address required.")] };
    const bad = servers.find((s) => !isValidIpv4(s));
    if (bad) return { output: [err(`% Invalid IPv4 address "${bad}".`)] };

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

// enable-view: `show ip dhcp-relay ...` — render only what was configured.
registerModal({
  id: "dhcp_relay-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "dhcp-relay") return null; // not ours
    const sub = (args[2] ?? "").toLowerCase();

    if (sub === "statistics") {
      // Statistics are runtime packet counters; the sim has no relay data-plane.
      return { output: [muted("% IP DHCP relay statistics are runtime counters; not simulated in this lab.")] };
    }

    let entries = (cpList(ctx.device, FEATURE, "interfaces") as unknown as RelayEntry[]).filter((e) => !isEmpty(e));
    if (sub === "detailed" && args[3]) entries = entries.filter((e) => e.interface === args[3]);
    if (entries.length === 0) return { output: [muted("No IP DHCP relay configured")] };

    const detailed = sub === "detailed";
    const out: OutputLine[] = [];
    for (const e of entries) {
      out.push(line(`Interface: ${e.interface}`));
      out.push(line(`  DHCP Relay Address: ${(e.servers ?? []).join(", ") || "-"}`));
      if (e.vrf) out.push(line(`  Server VRF: ${e.vrf}`));
      if (detailed) {
        if (e["source-interface"]) out.push(line(`  Source Interface: ${e["source-interface"]}`));
        if (e["max-hop-count"] != null) out.push(line(`  Max Hop Count: ${e["max-hop-count"]}`));
        if (e["policy-action"]) out.push(line(`  Policy Action: ${e["policy-action"]}`));
        if (e["circuit-id"]) out.push(line(`  Circuit Id Format: ${e["circuit-id"]}`));
        if (e["link-select"]) out.push(line("  Link Selection: enabled"));
        if (e["vrf-select"]) out.push(line("  VRF Selection: enabled"));
        if (e["smart-relay"]) out.push(line("  Smart Relay: enabled"));
      }
    }
    return { output: out };
  },
});
