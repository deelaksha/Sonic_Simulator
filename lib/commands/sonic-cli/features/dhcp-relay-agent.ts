/**
 * DHCP relay agent config (structured — drives the packet-plane relay in
 * lib/protocols/dhcp-relay.ts). In an interface config mode:
 *   ip dhcp-relay <server-ip>      add a relay destination
 *   no ip dhcp-relay <server-ip>   remove it
 *   show ip dhcp-relay             show the relay table
 * Non-IP `ip dhcp-relay ...` sub-options (source-interface, policy-action, …)
 * fall through to the config-plane handler.
 */
import { line, muted } from "../../types";
import { registerModal } from "../registry";
import type { DhcpRelayConfig } from "../../../protocols/dhcp-relay";

const isIpv4 = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

function relayMap(device: { config: { features?: Record<string, unknown> } }): DhcpRelayConfig {
  const f = device.config.features ?? (device.config.features = {});
  if (!f.dhcpRelay) f.dhcpRelay = {};
  return f.dhcpRelay as DhcpRelayConfig;
}

registerModal({
  id: "dhcp-relay-agent",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["ip"],
  run({ isNo, args, ifname, ctx }) {
    if (args[0]?.toLowerCase() !== "dhcp-relay") return null;
    const server = args[1];
    if (!server || !isIpv4(server)) return null; // sub-options handled elsewhere (config-plane)
    const map = relayMap(ctx.device);
    const name = ifname ?? "";
    const list = map[name] ?? (map[name] = []);
    map[name] = isNo ? list.filter((s) => s !== server) : list.includes(server) ? list : [...list, server];
    return { output: [muted(`DHCP relay ${isNo ? "removed" : "added"} on ${name}: ${server}`)] };
  },
});

registerModal({
  id: "dhcp-relay-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "dhcp-relay") return null;
    const map = (ctx.device.config.features?.dhcpRelay ?? {}) as DhcpRelayConfig;
    const entries = Object.entries(map).filter(([, v]) => v.length);
    if (!entries.length) return { output: [muted("No DHCP relay configured")] };
    const out = [line("Interface       Relay-Address"), line("--------------  -------------")];
    for (const [ifn, servers] of entries) out.push(line(`${ifn.padEnd(14)}  ${servers.join(", ")}`));
    return { output: out };
  },
});
