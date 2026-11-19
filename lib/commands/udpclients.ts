/**
 * UDP client tools: ntpdate (spec §23) and dhclient (spec §22). Each triggers a
 * real packet exchange through the simulation engine (same as ping) so the
 * topology animation, packet timeline, inspector, and tcpdump all light up.
 */
import { CommandHandler, CommandResult, OutputLine, line, err, muted } from "./types";
import { firstPositional } from "./parser";
import { isValidIpv4 } from "../models/ip";
import { interfaceByName } from "../models/device";

function secs(ms: number | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(6);
}

export const ntpdateCommand: CommandHandler = {
  name: "ntpdate",
  summary: "Query an NTP server (UDP/123) and show the clock offset",
  usage: "ntpdate <server-ip>",
  help: [
    "NTPDATE",
    "",
    "Usage:",
    "  ntpdate <server-ip>",
    "",
    "Sends a real NTP request over UDP/123 to the server and reports the",
    "stratum, offset and delay computed from the response.",
  ],
  run(args, ctx): CommandResult {
    const server = firstPositional(args);
    if (!server) return { output: [err("ntpdate: usage: ntpdate <server-ip|hostname>")] };

    // Resolve a hostname (e.g. time.google.com) to an IP via DNS first, then sync.
    let serverIp = server;
    const pre: OutputLine[] = [];
    let dnsEvents: unknown[] = [];
    if (!isValidIpv4(server)) {
      const dnsRun = ctx.runSim((sim) => sim.runDnsResolve(ctx.device.id, server));
      dnsEvents = dnsRun.events ?? [];
      if (!dnsRun.value.ok || !dnsRun.value.address) {
        return { output: [err(`ntpdate: ${server}: name resolution failed (configure a nameserver)`)], events: dnsEvents as never };
      }
      serverIp = dnsRun.value.address;
      pre.push(muted(`; resolved ${server} → ${serverIp} (DNS ${dnsRun.value.server})`));
    }

    const { value: r, events: syncEvents } = ctx.runSim((sim) => sim.runNtpSync(ctx.device.id, serverIp));
    const events = [...(dnsEvents as never[]), ...(syncEvents ?? [])];
    const out: OutputLine[] = [...pre];
    if (r.synced) {
      out.push(line(`server ${server}, stratum ${r.stratum}, offset ${secs(r.offsetMs)}, delay ${secs(r.delayMs)}`, "success"));
      out.push(line(`${new Date(0).toUTCString().slice(5, 25)}  ntpdate: adjust time server ${server} offset ${secs(r.offsetMs)} sec`));
    } else {
      const why =
        r.reason === "no-route"
          ? "no route to server"
          : r.reason === "timeout"
            ? "no response (is it an NTP server, and reachable?)"
            : r.reason;
      out.push(err(`ntpdate: no server suitable for synchronization found (${why})`));
    }
    return { output: out, events };
  },
};

export const dhclientCommand: CommandHandler = {
  name: "dhclient",
  summary: "Obtain (or release, -r) an IP address via DHCP (UDP 67/68)",
  usage: "dhclient [-r] [interface]",
  help: [
    "DHCLIENT",
    "",
    "Usage:",
    "  dhclient [interface]",
    "  dhclient -r [interface]",
    "",
    "Runs the DHCP DORA exchange (Discover / Offer / Request / Ack) as real",
    "broadcast frames and applies the assigned address to the interface.",
    "With a remembered lease it first asks for that address again (INIT-REBOOT);",
    "a DHCPNAK sends it back to Discover.",
    "-r sends DHCPRELEASE to the server and removes the address and default route.",
  ],
  run(args, ctx): CommandResult {
    const ifname = firstPositional(args);
    const iface = ifname ? interfaceByName(ctx.device, ifname) : ctx.device.interfaces[0];
    if (!iface) return { output: [err(`dhclient: ${ifname ?? "interface"}: no such interface`)] };

    if (args.includes("-r")) {
      const { value: rel, events } = ctx.runSim((sim) => sim.runDhcpRelease(ctx.device.id, iface.id));
      return { output: rel.released ? [muted(`DHCPRELEASE of ${rel.address} on ${iface.name} to ${rel.server} port 67`)] : [], events };
    }

    const { value: r, events } = ctx.runSim((sim) => sim.runDhcp(ctx.device.id, iface.id));
    const out: OutputLine[] = [];
    if (r.reboot) {
      out.push(muted(`DHCPREQUEST for ${r.reboot.requestedIp} on ${iface.name} to 255.255.255.255 port 67`));
      if (r.reboot.nakFrom) out.push(muted(`DHCPNAK from ${r.reboot.nakFrom}`));
    }
    if (r.reboot?.acked) {
      out.push(muted(`DHCPACK of ${r.assignedIp} from ${r.gateway}`));
      out.push(line(`bound to ${r.assignedIp}/${r.prefix} -- gateway ${r.gateway}, dns ${r.dns} -- renewal in 43200 seconds.`, "success"));
    } else if (r.success) {
      out.push(muted(`DHCPDISCOVER on ${iface.name} to 255.255.255.255 port 67`));
      out.push(muted(`DHCPOFFER of ${r.assignedIp} from ${r.gateway}`));
      out.push(muted(`DHCPREQUEST for ${r.assignedIp}`));
      out.push(muted(`DHCPACK of ${r.assignedIp} from ${r.gateway}`));
      out.push(line(`bound to ${r.assignedIp}/${r.prefix} -- gateway ${r.gateway}, dns ${r.dns} -- renewal in 43200 seconds.`, "success"));
    } else {
      const why = r.reason === "no-offer" ? "no DHCPOFFERS received (is a DHCP server on this LAN?)" : r.reason;
      out.push(err(`dhclient: ${why}`));
    }
    return { output: out, events };
  },
};
