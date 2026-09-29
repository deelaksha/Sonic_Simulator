/**
 * arp (spec §11, §15). Displays the device's neighbour cache — the same table
 * `ip neigh` reads and the ARP engine populates.
 */
import { CommandHandler, CommandResult, line, muted } from "./types";
import { findInterface } from "../models/device";

export const arpCommand: CommandHandler = {
  name: "arp",
  summary: "Display the ARP / neighbour cache",
  usage: "arp [-a] [-n]",
  help: [
    "ARP",
    "",
    "Usage:",
    "  arp [-a] [-n]",
    "",
    "Purpose:",
    "  Shows learned IP → MAC mappings. Populated by the ARP request/reply",
    "  exchange the engine performs before sending IP traffic.",
  ],
  run(args, ctx): CommandResult {
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
          return line(`? (${e.ip}) at ${e.mac} [ether]${on}`);
        }),
      };
    }

    // Linux tabular style
    const out = [line("Address          HWtype  HWaddress           Flags Mask  Iface")];
    for (const e of table) {
      const iface = findInterface(ctx.device, e.interfaceId);
      const flags = e.state === "incomplete" ? "(incomplete)" : "C";
      const hw = e.state === "incomplete" ? "" : e.mac;
      out.push(
        line(
          `${e.ip.padEnd(16)} ether   ${hw.padEnd(19)} ${flags.padEnd(5)}       ${iface?.name ?? ""}`,
        ),
      );
    }
    return { output: out };
  },
};
