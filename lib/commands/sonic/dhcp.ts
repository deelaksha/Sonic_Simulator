/**
 * DHCP relay SONiC feature module. Config-plane only (simulated CONFIG_DB): the
 * `config dhcp-relay ...` commands record helper (DHCP server) addresses per
 * interface in per-device feature state, and `show dhcp-relay` renders SOLELY
 * from that stored state.
 *
 *   config dhcp-relay add <iface> <server-ip>   add a helper address to an iface
 *   config dhcp-relay del <iface> <server-ip>   remove a helper address
 *   show dhcp-relay                             show configured relay helpers
 *
 * The helpers are stored in features["dhcpRelay"], which the relay data plane
 * (lib/protocols/dhcp-relay.ts) acts on; nothing here fabricates lease/DORA
 * output. Only the configured relay state is rendered.
 *
 * SOURCE NOTE: the authoritative sheet dhcp_udaykum.txt documents a DIFFERENT
 * DHCP surface — the "renew dhcp-lease interface Management 0" exec ACTION, which
 * (per its own "WHAT THIS FEATURE DOES *NOT* HAVE" section) has NO CONFIG_DB
 * table, no "no" form and no `show` counterpart. It carries no relay
 * helper-address config forms. These relay commands therefore follow standard
 * SONiC dhcp-relay click semantics (`config interface ip dhcp-relay add/del
 * <iface> <ip>`; `show dhcp_relay`), shortened to the ["dhcp-relay", ...] path
 * root as directed by the task.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4 } from "../../models/ip";
import { interfaceByName } from "../../models/device";
import type { DhcpRelayConfig } from "../../protocols/dhcp-relay";

/**
 * interface name -> ordered list of DHCP server (helper) IPs. The same store the KLISH
 * `ip dhcp-relay` handler (features/dhcp-relay-agent.ts), the relay data plane
 * (lib/protocols/dhcp-relay.ts), the running-config and the CONFIG_DB dhcp_servers
 * projection read: Click and KLISH write one CONFIG_DB leaf-list on the real switch.
 */
function relayMap(ctx: CommandContext): DhcpRelayConfig {
  return featureState<DhcpRelayConfig>(ctx.device, "dhcpRelay", () => ({}));
}

const config: SonicCmd[] = [
  {
    path: ["dhcp-relay", "add"],
    summary: "Add a DHCP relay helper (server) address to an interface",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      const ip = pos[1];
      if (!iface || !ip) return { output: [err("Usage: config dhcp-relay add <interface> <server-ip>")] };
      if (!interfaceByName(ctx.device, iface)) {
        return { output: [err(`config dhcp-relay add: interface ${iface} not found on ${ctx.device.name}`)] };
      }
      if (!isValidIpv4(ip)) {
        return { output: [err(`config dhcp-relay add: '${ip}' is not a valid IPv4 address`)] };
      }
      const relays = relayMap(ctx);
      if (!relays[iface]) relays[iface] = [];
      if (relays[iface].includes(ip)) {
        return { output: [muted(`DHCP relay ${ip} already configured on ${iface} (no-op)`)] };
      }
      relays[iface].push(ip);
      return { output: [muted(`DHCP relay ${ip} added to ${iface}`)] };
    },
  },
  {
    path: ["dhcp-relay", "del"],
    summary: "Remove a DHCP relay helper (server) address from an interface",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      const ip = pos[1];
      if (!iface || !ip) return { output: [err("Usage: config dhcp-relay del <interface> <server-ip>")] };
      if (!interfaceByName(ctx.device, iface)) {
        return { output: [err(`config dhcp-relay del: interface ${iface} not found on ${ctx.device.name}`)] };
      }
      const relays = relayMap(ctx);
      const list = relays[iface] ?? [];
      const idx = list.indexOf(ip);
      if (idx < 0) {
        return { output: [muted(`DHCP relay ${ip} not configured on ${iface} (no-op)`)] };
      }
      list.splice(idx, 1);
      if (list.length === 0) delete relays[iface];
      return { output: [muted(`DHCP relay ${ip} removed from ${iface}`)] };
    },
  },
];

function renderRelays(ctx: CommandContext): OutputLine[] {
  const relays = peekFeatureState<DhcpRelayConfig>(ctx.device, "dhcpRelay") ?? {};
  const ifaces = Object.keys(relays)
    .filter((i) => relays[i].length > 0)
    .sort();
  if (ifaces.length === 0) return [muted("No DHCP relay helper addresses configured")];
  const out: OutputLine[] = [line(`${"Interface".padEnd(17)}DHCP Relay Address`)];
  for (const iface of ifaces) {
    relays[iface].forEach((ip, i) => {
      out.push(line(`${(i === 0 ? iface : "").padEnd(17)}${ip}`));
    });
  }
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["dhcp-relay"],
    summary: "Show configured DHCP relay helper addresses",
    run: (_a, ctx) => ({ output: renderRelays(ctx) }),
  },
];

export const dhcpModule: SonicFeatureModule = { id: "dhcp", config, show };
