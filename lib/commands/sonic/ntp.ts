/**
 * NTP SONiC feature module (config-plane). Source: ntp.txt. Follows the
 * ./vlan.ts pattern; configuration is stored in device.config.features["ntp"]
 * via feature-state.ts. The Click `config ntp` verbs map to the cheatsheet's
 * KLISH forms:
 *
 *   config ntp add <ip>                 ntp server <ip>           (TC-55, TC-105)
 *   config ntp del <ip>                 no ntp server <ip>        (TC-85, TC-134)
 *   config ntp source-interface <intf>  ntp source-interface <i>  (TC-90)
 *   config ntp source-interface del     no ntp source-interface   (TC-95)
 *   config ntp vrf <name>               ntp vrf <name>            (TC-100)
 *   config ntp vrf del                  no ntp vrf                (TC-125)
 *   show ntp                            show ntp server / global  (TC-1, TC-52)
 *   show ntp associations               show ntp associations     (TC-53)
 *
 * Servers may be an IPv4 address OR a hostname (e.g. time.google.com) — a
 * hostname is resolved via DNS at sync time. `show ntp associations` runs a REAL
 * NTP sync over the network per configured server and shows live stratum/offset/
 * delay/reach (reach 0 / .INIT. when the server is unreachable).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4, isValidHostname } from "../../models/ip";

interface NtpState {
  servers: string[];
  sourceInterface: string | undefined;
  vrf: string | undefined;
}

function ntpState(ctx: CommandContext): NtpState {
  return featureState<NtpState>(ctx.device, "ntp", () => ({
    servers: [],
    sourceInterface: undefined,
    vrf: undefined,
  }));
}

/** KLISH spells a port as two tokens ("Ethernet 0"); Click uses one ("Ethernet0"). */
function joinIface(pos: string[]): string {
  return pos.length >= 2 && /^\d+$/.test(pos[1]) ? `${pos[0]}${pos[1]}` : pos[0];
}

const config: SonicCmd[] = [
  {
    path: ["ntp", "add"],
    summary: "Add an NTP server (ntp server <ip>)",
    run(args, ctx): CommandResult {
      const ip = positional(args)[0];
      if (!ip) return { output: [err("Usage: config ntp add <server-ip|hostname>")] };
      if (!isValidIpv4(ip) && !isValidHostname(ip)) {
        return { output: [err(`config ntp add: ${ip} is not a valid IPv4 address or hostname`)] };
      }
      const st = ntpState(ctx);
      if (st.servers.includes(ip)) return { output: [muted(`NTP server ${ip} already configured`)] };
      st.servers.push(ip);
      return { output: [muted(`NTP server ${ip} added`)] };
    },
  },
  {
    path: ["ntp", "del"],
    summary: "Remove an NTP server (no ntp server <ip>)",
    run(args, ctx): CommandResult {
      const ip = positional(args)[0];
      if (!ip) return { output: [err("Usage: config ntp del <server-ip>")] };
      const st = ntpState(ctx);
      if (!st.servers.includes(ip)) return { output: [err(`config ntp del: ${ip} is not a configured NTP server`)] };
      st.servers = st.servers.filter((s) => s !== ip);
      return { output: [muted(`NTP server ${ip} deleted`)] };
    },
  },
  {
    path: ["ntp", "source-interface"],
    summary: "Set/clear the NTP source interface (ntp source-interface <intf>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const st = ntpState(ctx);
      if (pos[0] === "del") {
        st.sourceInterface = undefined;
        return { output: [muted("NTP source-interface cleared")] };
      }
      if (!pos[0]) return { output: [err("Usage: config ntp source-interface <intf> | del")] };
      const intf = joinIface(pos);
      st.sourceInterface = intf;
      return { output: [muted(`NTP source-interface set to ${intf}`)] };
    },
  },
  {
    path: ["ntp", "vrf"],
    summary: "Set/clear the NTP VRF (ntp vrf <name>)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      const st = ntpState(ctx);
      if (name === "del") {
        st.vrf = undefined;
        return { output: [muted("NTP vrf cleared")] };
      }
      if (!name) return { output: [err("Usage: config ntp vrf <name> | del")] };
      st.vrf = name;
      return { output: [muted(`NTP vrf set to ${name}`)] };
    },
  },
];

function renderShowNtp(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<NtpState>(ctx.device, "ntp");
  const servers = st?.servers ?? [];
  const out: OutputLine[] = [line("NTP Servers")];
  if (servers.length === 0) out.push(muted("  (none configured)"));
  else for (const s of servers) out.push(line(`  ${s}`));
  out.push(muted(`Source interface: ${st?.sourceInterface ?? "(not set)"}`));
  out.push(muted(`VRF: ${st?.vrf ?? "default"}`));
  return out;
}

function renderAssociations(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<NtpState>(ctx.device, "ntp");
  const servers = st?.servers ?? [];
  if (servers.length === 0) return [muted("No NTP associations")];
  const out: OutputLine[] = [
    line("  remote            refid       st  when  poll  reach   delay   offset"),
    line("  ==================================================================="),
  ];
  for (const s of servers) {
    // Resolve a hostname to an IP (DNS), then run a real NTP sync over the network.
    const { value } = ctx.runSim((sim) => {
      const ip = isValidIpv4(s) ? s : sim.runDnsResolve(ctx.device.id, s).address;
      return ip ? sim.runNtpSync(ctx.device.id, ip) : undefined;
    });
    const remote = s.length > 16 ? s.slice(0, 15) + "…" : s.padEnd(16);
    if (value?.synced) {
      const delay = (value.delayMs ?? 0).toFixed(3).padStart(7);
      const offset = (value.offsetMs ?? 0).toFixed(3).padStart(7);
      out.push(line(`* ${remote}  LOCL       ${String(value.stratum ?? 1).padStart(3)}    32    64   377  ${delay} ${offset}`, "success"));
    } else {
      out.push(line(`  ${remote}  .INIT.      16     -    64     0    0.000   0.000`));
    }
  }
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["ntp", "associations"],
    summary: "Show NTP associations (config-plane placeholder)",
    run: (_a, ctx) => ({ output: renderAssociations(ctx) }),
  },
  {
    path: ["ntp"],
    summary: "Show NTP configuration (servers, source-interface, vrf)",
    run: (_a, ctx) => ({ output: renderShowNtp(ctx) }),
  },
];

export const ntpModule: SonicFeatureModule = { id: "ntp", config, show };
