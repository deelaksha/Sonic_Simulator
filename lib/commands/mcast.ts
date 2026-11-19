/**
 * `mcast` — simulator tool for IPv4 multicast on a host (what a receiver/sender
 * application does through its socket; there is no single Linux binary for it):
 *
 *   mcast join  <group> [-I <if>]   IP_ADD_MEMBERSHIP: the kernel sends an
 *                                   unsolicited IGMP report (v2 to the group, or
 *                                   v3 to 224.0.0.22) and answers queries after
 *   mcast leave <group> [-I <if>]   IP_DROP_MEMBERSHIP: IGMPv2 Leave to 224.0.0.2
 *                                   (or an IGMPv3 TO_IN {} report)
 *   mcast send  <group> [-c n] [-t ttl] [-p port] [-s bytes] [-i secs] [-I <if>]
 *                                   UDP datagrams to the group; -t sets
 *                                   IP_MULTICAST_TTL, whose Linux default is 1
 *                                   (ip(7)) — routed multicast needs -t > 1
 *   mcast show                      joined groups and datagrams received
 *   mcast maddr [dev <if>]          the multicast address list, in the layout of
 *                                   iproute2 `ip maddr show`
 *
 * Kernel behaviour lives in lib/protocols/mcast-host.ts.
 */
import { CommandHandler, CommandResult, OutputLine, err, line, muted } from "./types";
import { Device, isHost } from "../models/device";
import { NetInterface } from "../models/interface";
import { isMulticastIp, isLinkLocalGroup } from "../protocols/mcast-wire";
import { hostJoin, hostLeave, hostSend, peekHostMcast, renderMaddr } from "../protocols/mcast-host";
import { multicastMac } from "../control/packet";

const USAGE = "usage: mcast join|leave <group> [-I if] | send <group> [-c n] [-t ttl] [-p port] [-s bytes] [-i secs] [-I if] | show | maddr [dev if]";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function pickIface(device: Device, name: string | undefined): NetInterface | string {
  if (name) return device.interfaces.find((i) => i.name === name) ?? `mcast: ${name}: no such device`;
  return device.interfaces.find((i) => i.ipv4.length > 0 && i.adminState === "up") ?? "mcast: no configured interface";
}

function num(v: string | undefined, def: number, min: number, max: number): number | null {
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export const mcastCommand: CommandHandler = {
  name: "mcast",
  summary: "Join/leave IPv4 multicast groups, send to a group (simulator tool)",
  usage: "mcast join|leave|send|show|maddr ...",
  help: [
    "MCAST (simulator multicast socket tool)",
    "",
    "Usage:",
    "  mcast join  <group> [-I <if>]      join a group (IGMP report)",
    "  mcast leave <group> [-I <if>]      leave a group (IGMPv2 Leave / IGMPv3 TO_IN {})",
    "  mcast send  <group> [-c count] [-t ttl] [-p port] [-s bytes] [-i secs] [-I <if>]",
    "                                     send UDP datagrams (TTL defaults to 1 as on Linux)",
    "  mcast show                         joined groups + datagrams received per group",
    "  mcast maddr [dev <if>]             multicast addresses (ip maddr show layout)",
  ],
  run(args, ctx): CommandResult {
    const sub = args[0];
    if (!sub) return { output: [err(USAGE)] };
    if (!isHost(ctx.device.type)) return { output: [err("mcast: run it on a host (PC/server)")] };
    const deviceOf = (state: { devices: Record<string, Device> }) => state.devices[ctx.device.id];

    if (sub === "show") {
      const st = peekHostMcast(ctx.device);
      const out: OutputLine[] = [line("Interface  Group            Joined(s)  RxPackets  RxBytes  LastSource")];
      const now = Date.now();
      for (const g of st?.groups ?? []) {
        out.push(line(`${g.iface.padEnd(11)}${g.group.padEnd(17)}${String(Math.floor((now - g.sinceMs) / 1000)).padEnd(11)}${String(g.rxPackets).padEnd(11)}${String(g.rxBytes).padEnd(9)}${g.lastSource ?? "-"}`));
      }
      if (!st?.groups.length) out.push(muted("(no groups joined — mcast join <group>)"));
      for (const [g, n] of Object.entries(st?.tx ?? {})) out.push(muted(`sent ${n} datagram(s) to ${g}`));
      return { output: out };
    }
    if (sub === "maddr" || sub === "list") {
      const dev = flag(args, "dev");
      return { output: renderMaddr(ctx.device, dev).map((l) => line(l)) };
    }

    const group = args[1];
    if (!group || !isMulticastIp(group)) return { output: [err(`mcast: ${group ?? "<group>"}: not an IPv4 multicast address (224.0.0.0/4)`)] };
    const ifc = pickIface(ctx.device, flag(args, "-I"));
    if (typeof ifc === "string") return { output: [err(ifc)] };

    if (sub === "join" || sub === "leave") {
      if (isLinkLocalGroup(group)) return { output: [err(`mcast: ${group} is a link-local control group`)] };
      const r = ctx.runSim((sim) => {
        const dev = deviceOf(sim.state);
        const iface = dev.interfaces.find((i) => i.id === ifc.id)!;
        return sub === "join" ? hostJoin(sim, dev, iface, group) : hostLeave(sim, dev, iface, group);
      });
      if (r.value) return { output: [err(`mcast: ${r.value}`)], events: r.events };
      const what = sub === "join" ? `joined ${group} on ${ifc.name} (MAC ${multicastMac(group).toLowerCase()} added to the NIC filter)` : `left ${group} on ${ifc.name}`;
      return { output: [line(what)], events: r.events };
    }

    if (sub === "send") {
      const count = num(flag(args, "-c"), 1, 1, 100);
      const ttl = num(flag(args, "-t"), 1, 1, 255);
      const port = num(flag(args, "-p"), 5001, 1, 65535);
      const size = num(flag(args, "-s"), 64, 4, 1472);
      const secs = num(flag(args, "-i"), 1, 0, 60);
      if (count === null || ttl === null || port === null || size === null || secs === null) return { output: [err(USAGE)] };
      const r = ctx.runSim((sim) => {
        const dev = deviceOf(sim.state);
        const iface = dev.interfaces.find((i) => i.id === ifc.id)!;
        hostSend(sim, dev, iface, group, { count, ttl, port, size, intervalMs: secs * 1000 });
      });
      return {
        output: [line(`sent ${count} datagram(s) of ${size} bytes to ${group}:${port} via ${ifc.name}, ttl ${ttl}`)],
        events: r.events,
      };
    }
    return { output: [err(USAGE)] };
  },
};
