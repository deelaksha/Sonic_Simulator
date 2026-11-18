/**
 * Common SONiC `show` commands shared across features (task §17). All output is
 * rendered from live simulated state — never hardcoded.
 *
 *   show interfaces status      show mac / show mac address-table
 *   show ip interfaces          show running-config [vlan|interfaces]
 *   show version
 */
import { CommandContext, CommandResult, OutputLine, line, muted, err } from "../types";
import { SonicFeatureModule, SonicCmd, positional } from "./types";
import { findInterface, interfaceByName, isSwitch, isHost, isRouter } from "../../models/device";
import { listVlans, vlanMembers } from "../../models/vlan-ops";
import { isValidMac, normalizeMac } from "../../models/mac";

function ifaceStatus(ctx: CommandContext): OutputLine[] {
  const out = [
    line("Interface      Lanes    Speed    MTU    Admin      Oper     VLAN mode"),
    line("-------------  -------  -------  -----  ---------  -------  ----------"),
  ];
  ctx.device.interfaces.forEach((i, idx) => {
    const vlan = i.vlan.mode === "access" ? `access ${i.vlan.accessVlan}` : `trunk`;
    out.push(
      line(
        `${i.name.padEnd(13)}  ${String(idx * 4).padEnd(7)}  ${(i.speed + "M").padEnd(7)}  1500   ${i.adminState.padEnd(9)}  ${i.operState.padEnd(7)}  ${vlan}`,
      ),
    );
  });
  return out;
}

function macTable(ctx: CommandContext): OutputLine[] {
  if (!isSwitch(ctx.device.type)) return [muted("MAC table is only available on switches")];
  if (ctx.device.macTable.length === 0) return [muted("No entries present.")];
  const out = [
    line("No.    Vlan  MacAddress          Port         Type"),
    line("-----  ----  ------------------  -----------  --------"),
  ];
  ctx.device.macTable.forEach((m, i) => {
    // EVPN-installed remote MACs sit behind a VXLAN tunnel (fdbshow prints the tunnel, type Static).
    const remote = m.interfaceId.startsWith("vtep:");
    const port = remote ? `VxLAN DIP: ${m.interfaceId.slice(5)}` : (findInterface(ctx.device, m.interfaceId)?.name ?? m.interfaceId);
    out.push(
      line(`${String(i + 1).padEnd(5)}  ${String(m.vlan).padEnd(4)}  ${m.mac.padEnd(18)}  ${port.padEnd(11)}  ${remote ? "Static" : "Dynamic"}`),
    );
  });
  out.push(muted(`Total number of entries ${ctx.device.macTable.length}`));
  return out;
}

function ipInterfaces(ctx: CommandContext): OutputLine[] {
  const out = [
    line("Interface      IPv4 address/mask      Admin/Oper"),
    line("-------------  ---------------------  ------------"),
  ];
  let any = false;
  for (const i of ctx.device.interfaces) {
    for (const a of i.ipv4) {
      any = true;
      out.push(line(`${i.name.padEnd(13)}  ${`${a.address}/${a.prefix}`.padEnd(21)}  ${i.adminState}/${i.operState}`));
    }
  }
  if (!any) out.push(muted("(no IPv4 addresses configured)"));
  return out;
}

function runningConfig(ctx: CommandContext, section?: string): OutputLine[] {
  const out: OutputLine[] = [];
  const wantVlan = !section || section === "vlan";
  const wantIf = !section || section === "interfaces" || section === "interface";

  if (wantVlan && isSwitch(ctx.device.type)) {
    const vlans = [...listVlans(ctx.device)].sort((a, b) => a.id - b.id);
    for (const v of vlans) {
      out.push(line(`vlan ${v.id}`));
      for (const m of vlanMembers(ctx.device, v.id)) {
        out.push(line(`  member ${m.port} ${m.tagged ? "tagged" : "untagged"}`));
      }
    }
  }
  if (wantIf) {
    for (const i of ctx.device.interfaces) {
      const hasCfg = i.ipv4.length > 0 || i.adminState === "down";
      if (!hasCfg) continue;
      out.push(line(`interface ${i.name}`));
      if (i.adminState === "down") out.push(line("  shutdown"));
      for (const a of i.ipv4) out.push(line(`  ip address ${a.address}/${a.prefix}`));
    }
  }
  if (out.length === 0) out.push(muted("!"));
  return out;
}

const show: SonicCmd[] = [
  { path: ["interfaces", "status"], summary: "Interface status", run: (_a, ctx) => ({ output: ifaceStatus(ctx) }) },
  { path: ["interface", "status"], summary: "Interface status", run: (_a, ctx) => ({ output: ifaceStatus(ctx) }) },
  { path: ["mac", "address-table"], summary: "MAC address table", run: (_a, ctx) => ({ output: macTable(ctx) }) },
  { path: ["mac"], summary: "MAC address table", run: (_a, ctx) => ({ output: macTable(ctx) }) },
  { path: ["ip", "interfaces"], summary: "IPv4 interface addresses", run: (_a, ctx) => ({ output: ipInterfaces(ctx) }) },
  {
    path: ["running-configuration"],
    summary: "Running configuration",
    run: (a, ctx) => ({ output: runningConfig(ctx, positional(a)[0]) }),
  },
  {
    path: ["running-config"],
    summary: "Running configuration",
    run: (a, ctx) => ({ output: runningConfig(ctx, positional(a)[0]) }),
  },
  {
    path: ["version"],
    summary: "Software version",
    run: (_a, ctx) => ({
      output: [
        line("SONiC Software Version: SONiC-Lab-Simulation"),
        muted(`Platform: networklab-sim   HwSKU: ${isHost(ctx.device.type) ? "host" : isRouter(ctx.device.type) ? "router" : "switch"}`),
        muted("Note: simulated environment (not a real device)."),
      ],
    }),
  },
];

const config: SonicCmd[] = [
  {
    path: ["save"],
    summary: "Persist running configuration",
    run: () => ({ output: [muted("Running configuration saved to startup.")] }),
  },
  {
    path: ["mac", "add"],
    summary: "Add static MAC address table entry (config mac add <vlan> <mac> <port>)",
    run(args, ctx): CommandResult {
      if (!isSwitch(ctx.device.type)) return { output: [err("MAC configuration is only available on switches")] };
      const pos = positional(args);
      const vlanId = Number(pos[0]);
      const mac = pos[1];
      const portName = pos[2];
      if (!vlanId || !mac || !portName || !isValidMac(mac)) {
        return { output: [err("Usage: config mac add <vlan> <mac> <port>")] };
      }
      const iface = interfaceByName(ctx.device, portName);
      if (!iface) return { output: [err(`config mac add: port '${portName}' not found`)] };
      const normMac = normalizeMac(mac);
      ctx.device.macTable = ctx.device.macTable.filter((e) => !(e.vlan === vlanId && normalizeMac(e.mac) === normMac));
      ctx.device.macTable.push({ mac: normMac, interfaceId: iface.id, vlan: vlanId });
      return { output: [muted(`Added MAC ${normMac} on VLAN ${vlanId} dev ${iface.name}`)] };
    },
  },
  {
    path: ["mac", "del"],
    summary: "Delete MAC address table entry (config mac del <vlan> <mac>)",
    run(args, ctx): CommandResult {
      if (!isSwitch(ctx.device.type)) return { output: [err("MAC configuration is only available on switches")] };
      const pos = positional(args);
      const vlanId = Number(pos[0]);
      const mac = pos[1];
      if (!vlanId || !mac || !isValidMac(mac)) {
        return { output: [err("Usage: config mac del <vlan> <mac>")] };
      }
      const normMac = normalizeMac(mac);
      const before = ctx.device.macTable.length;
      ctx.device.macTable = ctx.device.macTable.filter((e) => !(e.vlan === vlanId && normalizeMac(e.mac) === normMac));
      if (ctx.device.macTable.length === before) {
        return { output: [err(`config mac del: entry for ${mac} in VLAN ${vlanId} not found`)] };
      }
      return { output: [muted(`Deleted MAC ${normMac} on VLAN ${vlanId}`)] };
    },
  },
  {
    path: ["mac", "clear"],
    summary: "Clear all dynamic MAC address table entries",
    run(_args, ctx): CommandResult {
      if (!isSwitch(ctx.device.type)) return { output: [err("MAC configuration is only available on switches")] };
      const count = ctx.device.macTable.length;
      ctx.device.macTable = [];
      return { output: [muted(`Cleared ${count} entries from MAC table`)] };
    },
  },
];

export const commonModule: SonicFeatureModule = { id: "common", config, show };
