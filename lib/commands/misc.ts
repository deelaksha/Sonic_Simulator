/**
 * Small built-ins: hostname, clear, and the legacy net-tools commands
 * (ifconfig, route) that read the same simulated state as their `ip` equivalents.
 */
import { CommandHandler, CommandResult, OutputLine, line, muted } from "./types";
import { findInterface } from "../models/device";
import { prefixToMask, broadcastAddress } from "../models/ip";

export const hostnameCommand: CommandHandler = {
  name: "hostname",
  summary: "Show the device hostname",
  usage: "hostname",
  help: ["HOSTNAME", "", "Usage:", "  hostname", "", "Prints this device's configured hostname."],
  run(_args, ctx): CommandResult {
    return { output: [line(ctx.device.config.hostname)] };
  },
};

export const clearCommand: CommandHandler = {
  name: "clear",
  aliases: ["cls"],
  summary: "Clear the terminal scrollback",
  usage: "clear",
  help: ["CLEAR", "", "Usage:", "  clear", "", "Clears the terminal output."],
  run(): CommandResult {
    return { output: [], clear: true };
  },
};

export const ifconfigCommand: CommandHandler = {
  name: "ifconfig",
  summary: "Legacy interface viewer (net-tools)",
  usage: "ifconfig",
  help: ["IFCONFIG", "", "Usage:", "  ifconfig", "", "Legacy view of interfaces; prefer `ip addr`."],
  run(_args, ctx): CommandResult {
    const out: OutputLine[] = [];
    for (const iface of ctx.device.interfaces) {
      const flags = ["UP", "BROADCAST", iface.operState === "up" ? "RUNNING" : "", "MULTICAST"]
        .filter(Boolean)
        .join(",");
      out.push(line(`${iface.name}: flags=<${flags}>  mtu 1500`));
      for (const a of iface.ipv4) {
        out.push(
          line(
            `        inet ${a.address}  netmask ${prefixToMask(a.prefix)}  broadcast ${broadcastAddress(a.address, a.prefix)}`,
          ),
        );
      }
      out.push(muted(`        ether ${iface.mac}  txqueuelen 1000  (Ethernet)`));
      out.push(
        muted(
          `        RX packets ${iface.statistics.rxFrames}  bytes ${iface.statistics.rxBytes}`,
        ),
      );
      out.push(
        muted(
          `        TX packets ${iface.statistics.txFrames}  bytes ${iface.statistics.txBytes}`,
        ),
      );
      out.push(line(""));
    }
    return { output: out };
  },
};

export const routeCommand: CommandHandler = {
  name: "route",
  summary: "Legacy routing table viewer (net-tools)",
  usage: "route [-n]",
  help: ["ROUTE", "", "Usage:", "  route [-n]", "", "Legacy view of the routing table; prefer `ip route`."],
  run(_args, ctx): CommandResult {
    const out: OutputLine[] = [
      line("Kernel IP routing table"),
      line("Destination     Gateway         Genmask         Flags Metric Ref    Use Iface"),
    ];
    for (const r of ctx.device.routingTable) {
      const iface = findInterface(ctx.device, r.interfaceId);
      const dest = r.prefix === 0 ? "0.0.0.0" : r.destination;
      const gw = r.nextHop ?? "0.0.0.0";
      const genmask = prefixToMask(r.prefix);
      const flags = r.type === "connected" ? "U" : "UG";
      out.push(
        line(
          `${dest.padEnd(15)} ${gw.padEnd(15)} ${genmask.padEnd(15)} ${flags.padEnd(5)} ${String(r.metric).padEnd(6)} 0        0 ${iface?.name ?? ""}`,
        ),
      );
    }
    return { output: out };
  },
};
