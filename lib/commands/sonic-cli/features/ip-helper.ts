/**
 * IP Helper (ip forward-protocol) — CONFIG-PLANE feature (no engine backend).
 *
 * Global UDP-broadcast-forwarding config, stored and rendered back honestly:
 *
 *   sonic(config)# ip forward-protocol udp enable          admin_mode on
 *   sonic(config)# no ip forward-protocol udp enable        admin_mode off
 *   sonic(config)# ip forward-protocol udp rate-limit 2000  incoming rate limit
 *   sonic(config)# no ip forward-protocol udp rate-limit    clear rate limit
 *   sonic(config)# ip forward-protocol udp include tftp     enable a UDP port
 *   sonic(config)# ip forward-protocol udp exclude tftp     disable a UDP port
 *   sonic# show ip forward-protocol                          render from stored state
 *
 * Mirrors CONFIG_DB (UDP_BROADCAST_FORWARDING): admin_mode, rate_limit_pps and
 * two port lists (include_ports / exclude_ports). The actual UDP-broadcast
 * relaying (data-plane) and the packet counters (`show ip helper-address
 * statistics`) are runtime state the sim does not model, so they are not shown.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";

const ID = "ip-helper";

// Well-known UDP ports the box accepts by keyword (else a custom 0-65535 port).
const WELL_KNOWN = ["tftp", "dns", "ntp", "netbios-name-server", "netbios-datagram-server", "tacacs"];
const PORT_DISPLAY: Record<string, string> = {
  tftp: "TFTP",
  dns: "DNS",
  ntp: "NTP",
  tacacs: "TACACS",
  "netbios-name-server": "NetBios-Name-Server",
  "netbios-datagram-server": "NetBios-Datagram-Server",
};

function normalizePort(p: string): string | null {
  const low = p.toLowerCase();
  if (WELL_KNOWN.includes(low)) return low;
  const n = Number(p);
  if (Number.isInteger(n) && n >= 0 && n <= 65535) return String(n);
  return null;
}

function portDisplay(p: string): string {
  return PORT_DISPLAY[p] ?? p;
}

// configure-view: `ip forward-protocol udp {enable|rate-limit|include|exclude}`.
registerModal({
  id: ID,
  views: ["configure-view"],
  keywords: ["ip"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "forward-protocol") return null; // not ours (ip route, ...)
    if (args[1]?.toLowerCase() !== "udp") {
      return { output: [err("% Usage: ip forward-protocol udp {enable | rate-limit <rate> | include <port> | exclude <port>}")] };
    }
    const sub = args[2]?.toLowerCase();
    const dev = ctx.device;

    if (sub === "enable") {
      cpSet(dev, ID, "enable", !isNo);
      return { output: [] };
    }

    if (sub === "rate-limit") {
      if (isNo) {
        cpUnset(dev, ID, "rate_limit");
        return { output: [] };
      }
      const rate = Number(args[3]);
      if (!args[3] || !Number.isInteger(rate) || rate < 600 || rate > 10000) {
        return { output: [err("% rate-limit must be an integer between 600 and 10000 pps")] };
      }
      cpSet(dev, ID, "rate_limit", rate);
      return { output: [] };
    }

    if (sub === "include" || sub === "exclude") {
      const port = args[3] ? normalizePort(args[3]) : null;
      if (!port) {
        return { output: [err(`% UDP port must be one of ${WELL_KNOWN.join("|")} or a number 0-65535`)] };
      }
      // A port is either enabled (include) or disabled (exclude) — never both.
      const [into, other] = sub === "include" ? ["include", "exclude"] : ["exclude", "include"];
      cpRemove(dev, ID, other, "port", port);
      cpUpsert(dev, ID, into, { port }, "port");
      return { output: [] };
    }

    return { output: [err("% Usage: ip forward-protocol udp {enable | rate-limit <rate> | include <port> | exclude <port>}")] };
  },
});

// enable-view: `show ip forward-protocol` — render the stored global config.
registerModal({
  id: "ip-helper-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "forward-protocol") return null; // not ours
    const st = cpGet(ctx.device, ID);
    if (!st || Object.keys(st).length === 0) return { output: [muted("No IP helper configuration")] };

    const out = [line(`UDP forwarding  : ${st.enable === true ? "Enabled" : "Disabled"}`)];
    if (st.rate_limit !== undefined) out.push(line(`UDP rate limit  : ${st.rate_limit} pps`));

    const enabled = cpList(ctx.device, ID, "include").map((e) => portDisplay(String(e.port)));
    const disabled = cpList(ctx.device, ID, "exclude").map((e) => portDisplay(String(e.port)));
    if (enabled.length) out.push(line(`UDP forwarding enabled on the ports: ${enabled.join(", ")}`));
    if (disabled.length) out.push(line(`UDP forwarding disabled on the ports: ${disabled.join(", ")}`));

    return { output: out };
  },
});
