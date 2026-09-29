/**
 * DNS resolver SONiC feature module. Config-plane only: it stores the configured
 * nameserver list; there is no DNS packet engine yet, so `show` renders SOLELY
 * from stored state (no resolution is simulated). Commands are traceable to the
 * CLICK surface in dns_udaykum.txt.
 *
 *   config dns nameserver add <ip>     show dns nameserver
 *   config dns nameserver del <ip>
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4 } from "../../models/ip";

interface DnsState {
  nameservers: string[];
}

/** sonic-dns.yang max-elements 3 / CLICK NAMESERVERS_MAX_NUM=3 (dns_udaykum.txt). */
const MAX_NAMESERVERS = 3;

function dnsState(ctx: CommandContext): DnsState {
  return featureState<DnsState>(ctx.device, "dns", () => ({ nameservers: [] }));
}

const config: SonicCmd[] = [
  {
    path: ["dns", "nameserver", "add"],
    summary: "Add a DNS nameserver",
    run(args, ctx): CommandResult {
      const ip = positional(args)[0];
      if (!ip) return { output: [err("Usage: config dns nameserver add <ip_address>")] };
      if (!isValidIpv4(ip)) return { output: [err(`Error: ${ip} invalid nameserver ip address`)] };
      const st = dnsState(ctx);
      if (st.nameservers.includes(ip)) return { output: [err(`Error: DNS nameserver ${ip} is already configured`)] };
      if (st.nameservers.length >= MAX_NAMESERVERS)
        return { output: [err(`Error: the maximum number of nameservers (${MAX_NAMESERVERS}) would be exceeded`)] };
      st.nameservers.push(ip);
      return { output: [muted(`DNS nameserver ${ip} added`)] };
    },
  },
  {
    path: ["dns", "nameserver", "del"],
    summary: "Delete a DNS nameserver",
    run(args, ctx): CommandResult {
      const ip = positional(args)[0];
      if (!ip) return { output: [err("Usage: config dns nameserver del <ip_address>")] };
      const st = dnsState(ctx);
      const i = st.nameservers.indexOf(ip);
      if (i < 0) return { output: [err(`Error: DNS nameserver ${ip} is not configured`)] };
      st.nameservers.splice(i, 1);
      return { output: [muted(`DNS nameserver ${ip} deleted`)] };
    },
  },
];

function renderNameservers(ctx: CommandContext): OutputLine[] {
  const servers = peekFeatureState<DnsState>(ctx.device, "dns")?.nameservers ?? [];
  const out: OutputLine[] = [line("    Nameserver"), line("  ------------")];
  for (const ip of servers) out.push(line(ip.padStart(14)));
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["dns", "nameserver"],
    summary: "Show configured DNS nameservers",
    run: (_a, ctx) => ({ output: renderNameservers(ctx) }),
  },
];

export const dnsModule: SonicFeatureModule = { id: "dns", config, show };
