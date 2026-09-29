/**
 * Interface SONiC feature module. Config changes mutate the SAME interface model
 * the packet engine reads, so they produce real state transitions (connected
 * routes rebuilt; ping starts/stops working). The click forms mirror the
 * interface operations exercised in interface.txt — IPv4 addressing
 * (`ip address 10.10.10.1/24` / `no ip address ...`, TC-4/TC-5) and admin state
 * (`shutdown` / `no shutdown`, TC-10/TC-11) — expressed as SONiC click commands
 * (see index.ts help). Follows the ./vlan.ts pattern.
 *
 *   config interface ip add <port> <ip>/<prefix>
 *   config interface ip del <port> <ip>/<prefix>
 *   config interface startup <port>
 *   config interface shutdown <port>
 *   show interfaces
 *
 * NOTE: `show interfaces status`, `show ip interfaces`, `show mac` live in
 * ./common.ts and are intentionally NOT re-implemented here.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { interfaceByName } from "../../models/device";
import { NetInterface, primaryIpv4 } from "../../models/interface";
import { isValidIpv4, isValidPrefix } from "../../models/ip";
import { rebuildConnectedRoutes } from "../../models/factory";

function findPort(ctx: CommandContext, name: string | undefined): NetInterface | undefined {
  return name ? interfaceByName(ctx.device, name) : undefined;
}

/** Parse an `<ip>/<prefix>` token into a validated address, or null. */
function parseCidr(tok: string | undefined): { address: string; prefix: number } | null {
  if (!tok || !tok.includes("/")) return null;
  const [address, prefixTok] = tok.split("/");
  const prefix = Number(prefixTok);
  if (!isValidIpv4(address) || !isValidPrefix(prefix)) return null;
  return { address, prefix };
}

const config: SonicCmd[] = [
  {
    path: ["interface", "ip", "add"],
    summary: "Assign an IPv4 address to a port",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = findPort(ctx, pos[0]);
      if (!iface) return { output: [err(`config interface ip add: no such interface '${pos[0] ?? ""}'`)] };
      const cidr = parseCidr(pos[1]);
      if (!cidr) return { output: [err("Usage: config interface ip add <port> <ip>/<prefix>")] };
      if (iface.ipv4.some((a) => a.address === cidr.address && a.prefix === cidr.prefix)) {
        return { output: [muted(`${iface.name} already has ${cidr.address}/${cidr.prefix}`)] };
      }
      iface.ipv4.push({ address: cidr.address, prefix: cidr.prefix });
      rebuildConnectedRoutes(ctx.device);
      return { output: [muted(`${cidr.address}/${cidr.prefix} added to ${iface.name}`)] };
    },
  },
  {
    path: ["interface", "ip", "del"],
    summary: "Remove an IPv4 address from a port",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = findPort(ctx, pos[0]);
      if (!iface) return { output: [err(`config interface ip del: no such interface '${pos[0] ?? ""}'`)] };
      const cidr = parseCidr(pos[1]);
      if (!cidr) return { output: [err("Usage: config interface ip del <port> <ip>/<prefix>")] };
      const before = iface.ipv4.length;
      iface.ipv4 = iface.ipv4.filter((a) => !(a.address === cidr.address && a.prefix === cidr.prefix));
      if (iface.ipv4.length === before) {
        return { output: [err(`${iface.name} has no address ${cidr.address}/${cidr.prefix}`)] };
      }
      rebuildConnectedRoutes(ctx.device);
      return { output: [muted(`${cidr.address}/${cidr.prefix} removed from ${iface.name}`)] };
    },
  },
  {
    path: ["interface", "startup"],
    summary: "Bring a port administratively up",
    run(args, ctx): CommandResult {
      const port = positional(args)[0];
      const iface = findPort(ctx, port);
      if (!iface) return { output: [err(`config interface startup: no such interface '${port ?? ""}'`)] };
      iface.adminState = "up";
      iface.operState = iface.connectedTo ? "up" : "down";
      rebuildConnectedRoutes(ctx.device);
      return { output: [muted(`${iface.name} admin up`)] };
    },
  },
  {
    path: ["interface", "shutdown"],
    summary: "Shut a port down administratively",
    run(args, ctx): CommandResult {
      const port = positional(args)[0];
      const iface = findPort(ctx, port);
      if (!iface) return { output: [err(`config interface shutdown: no such interface '${port ?? ""}'`)] };
      iface.adminState = "down";
      iface.operState = "down";
      rebuildConnectedRoutes(ctx.device);
      return { output: [muted(`${iface.name} admin down`)] };
    },
  },
];

function renderInterfaces(ctx: CommandContext): OutputLine[] {
  const out: OutputLine[] = [
    line("Interface      Admin      Oper     MAC                 IPv4 address/mask"),
    line("-------------  ---------  -------  ------------------  ---------------------"),
  ];
  for (const i of ctx.device.interfaces) {
    const ip = primaryIpv4(i);
    out.push(
      line(
        `${i.name.padEnd(13)}  ${i.adminState.padEnd(9)}  ${i.operState.padEnd(7)}  ${i.mac.padEnd(18)}  ${ip ? `${ip.address}/${ip.prefix}` : "-"}`,
      ),
    );
  }
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["interfaces"],
    summary: "Detailed interface list (admin/oper/mac/ip)",
    run: (_a, ctx) => ({ output: renderInterfaces(ctx) }),
  },
];

export const interfaceModule: SonicFeatureModule = { id: "interface", config, show };
