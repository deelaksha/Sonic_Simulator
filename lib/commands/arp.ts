/**
 * arp (spec §11, §15). Displays the device's neighbour cache — the same table
 * `ip neigh` reads and the ARP engine populates. Formats follow net-tools
 * arp.c arp_disp / arp_disp_2: flags C (complete), M (permanent), and
 * "(incomplete)" for entries still waiting for a reply. STALE entries are
 * complete (they still have a link-layer address).
 */
import { CommandHandler, CommandResult, line, muted, err } from "./types";
import { findInterface, interfaceByName } from "../models/device";
import { isPermanent, addStaticArp, deleteArp } from "../protocols/arp";
import { isValidIpv4 } from "../models/ip";
import { isValidMac, normalizeMac } from "../models/mac";

export const arpCommand: CommandHandler = {
  name: "arp",
  summary: "Display or manipulate the ARP / neighbour cache",
  usage: "arp [-a] [-n] [-d <ip>] [-s <ip> <mac> [dev <iface>]]",
  help: [
    "ARP",
    "",
    "Usage:",
    "  arp [-a] [-n]                  Display ARP cache",
    "  arp -d <ip>                    Delete ARP cache entry",
    "  arp -s <ip> <mac> [dev <if>]   Add static ARP entry",
    "",
    "Purpose:",
    "  Shows and manages learned IP → MAC mappings. Populated by the ARP",
    "  request/reply exchange the engine performs before sending IP traffic.",
  ],
  run(args, ctx): CommandResult {
    // Delete entry: arp -d <ip>
    const dIdx = args.indexOf("-d");
    if (dIdx >= 0) {
      const targetIp = args[dIdx + 1];
      if (!targetIp || !isValidIpv4(targetIp)) {
        return { output: [err("Usage: arp -d <ip>")] };
      }
      deleteArp(ctx.device, targetIp);
      return { output: [muted(`Deleted ARP entry for ${targetIp}`)] };
    }

    // Static entry: arp -s <ip> <mac> [dev <iface>]
    const sIdx = args.indexOf("-s");
    if (sIdx >= 0) {
      const ip = args[sIdx + 1];
      const mac = args[sIdx + 2];
      if (!ip || !isValidIpv4(ip) || !mac || !isValidMac(mac)) {
        return { output: [err("Usage: arp -s <ip> <mac> [dev <iface>]")] };
      }
      const devIdx = args.indexOf("dev");
      const devName = devIdx >= 0 ? args[devIdx + 1] : args[sIdx + 3] && !args[sIdx + 3].startsWith("-") ? args[sIdx + 3] : undefined;
      let iface = devName ? interfaceByName(ctx.device, devName) : undefined;
      if (!iface) {
        iface = ctx.device.interfaces[0];
      }
      if (!iface) {
        return { output: [err("arp -s: no interface found on device")] };
      }
      addStaticArp(ctx.device, ip, normalizeMac(mac), iface.id, Date.now());
      return { output: [muted(`Added static ARP entry: ${ip} -> ${normalizeMac(mac)} on ${iface.name}`)] };
    }

    const bsd = args.includes("-a");
    const table = ctx.device.arpTable;
    if (table.length === 0) {
      return { output: [muted("(ARP cache is empty)")] };
    }

    if (bsd) {
      // BSD style: ? (192.168.1.1) at aa:bb:.. [ether] on eth0
      return {
        output: table.map((e) => {
          const iface = findInterface(ctx.device, e.interfaceId);
          const on = iface ? ` on ${iface.name}` : "";
          if (e.state === "incomplete") return line(`? (${e.ip}) at <incomplete>${on}`);
          const perm = isPermanent(ctx.device, e.ip) ? " PERM" : "";
          return line(`? (${e.ip}) at ${e.mac.toLowerCase()} [ether]${perm}${on}`);
        }),
      };
    }

    // Linux tabular style: "%-23.23s  " name, "%-8.8s%-20.20s" type+hwaddr, "%-6.6s%-15.15s %s" flags mask iface.
    const out = [line("Address                  HWtype  HWaddress           Flags Mask            Iface")];
    for (const e of table) {
      const iface = findInterface(ctx.device, e.interfaceId)?.name ?? "";
      const incomplete = e.state === "incomplete";
      const type = incomplete ? "" : "ether";
      const hw = incomplete ? "(incomplete)" : e.mac.toLowerCase();
      const flags = incomplete ? "" : isPermanent(ctx.device, e.ip) ? "CM" : "C";
      out.push(line(`${e.ip.padEnd(23)}  ${type.padEnd(8)}${hw.padEnd(20)}${flags.padEnd(6)}${"".padEnd(15)} ${iface}`));
    }
    return { output: out };
  },
};
