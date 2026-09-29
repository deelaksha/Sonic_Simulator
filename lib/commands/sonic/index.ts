/**
 * SONiC command layer entry point. Composes all feature modules into the
 * central `config` and `show` handlers (task §12-§18). To add a feature, create
 * a module file (see ./vlan.ts) and add it to MODULES below — one line, no other
 * file changes, so features stay independent.
 */
import { CommandHandler, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, matchSonic } from "./types";
import { commonModule } from "./common";
import { vlanModule } from "./vlan";
import { staticRouteModule } from "./staticroute";
import { interfaceModule } from "./interface";
import { arpndModule } from "./arpnd";
import { ntpModule } from "./ntp";
import { dnsModule } from "./dns";
import { snmpModule } from "./snmp";
import { aaaModule } from "./aaa";
import { tacacsModule } from "./tacacs";
import { radiusModule } from "./radius";
import { lldpModule } from "./lldp";
import { vrfModule } from "./vrf";
import { vrrpModule } from "./vrrp";
import { prefixListModule } from "./prefixlist";
import { routeMapModule } from "./routemap";
import { aclModule } from "./acl";
import { coppModule } from "./copp";
import { sflowModule } from "./sflow";
import { dhcpModule } from "./dhcp";
import { lacpModule } from "./lacp";
import { bfdModule } from "./bfd";
import { ospfModule } from "./ospf";
import { bgpModule } from "./bgp";
import { qosModule } from "./qos";
import { qosPfcModule } from "./qospfc";
import { qosCounterpollModule } from "./qoscounterpoll";
import { fbsModule } from "./fbs";
import { platformModule } from "./platform";
import { pboModule } from "./pbo";
import { ipv6Module } from "./ipv6";

const MODULES: SonicFeatureModule[] = [
  commonModule,
  vlanModule,
  staticRouteModule,
  interfaceModule,
  arpndModule,
  ntpModule,
  dnsModule,
  snmpModule,
  aaaModule,
  tacacsModule,
  radiusModule,
  lldpModule,
  vrfModule,
  vrrpModule,
  prefixListModule,
  routeMapModule,
  aclModule,
  coppModule,
  sflowModule,
  dhcpModule,
  lacpModule,
  bfdModule,
  ospfModule,
  bgpModule,
  qosModule,
  qosPfcModule,
  qosCounterpollModule,
  fbsModule,
  platformModule,
  pboModule,
  ipv6Module,
];

const CONFIG_CMDS: SonicCmd[] = MODULES.flatMap((m) => m.config);
const SHOW_CMDS: SonicCmd[] = MODULES.flatMap((m) => m.show);

/** Feature ids that contributed commands (for the feature panel / status). */
export function implementedSonicFeatures(): string[] {
  return MODULES.filter((m) => m.id !== "common").map((m) => m.id);
}

function usageList(cmds: SonicCmd[], verb: string): OutputLine[] {
  return [
    muted(`Available '${verb}' sub-commands:`),
    ...[...cmds]
      .sort((a, b) => a.path.join(" ").localeCompare(b.path.join(" ")))
      .map((c) => line(`  ${verb} ${c.path.join(" ").padEnd(28)} ${c.summary}`)),
  ];
}

export const configCommand: CommandHandler = {
  name: "config",
  cli: "sonic",
  summary: "SONiC configuration (config vlan/interface/route ...)",
  usage: "config <object> ...",
  help: [
    "CONFIG (SONiC)",
    "",
    "Usage:",
    "  config vlan add <id> | del <id>",
    "  config vlan member add [-u] <id> <port> | del <id> <port>",
    "  config interface ip add/del <port> <cidr>; startup/shutdown <port>",
    "  config route add prefix <cidr> nexthop <ip>",
    "",
    "Changes the same state the packet engine uses.",
  ],
  run(args, ctx): CommandResult {
    if (args.length === 0) return { output: usageList(CONFIG_CMDS, "config") };
    const m = matchSonic(CONFIG_CMDS, args);
    if (!m) {
      return {
        output: [err(`config: unknown command '${args.join(" ")}'`), ...usageList(CONFIG_CMDS, "config")],
      };
    }
    return m.cmd.run(m.rest, ctx);
  },
};

export const showCommand: CommandHandler = {
  name: "show",
  cli: "sonic",
  summary: "SONiC show commands (show vlan/interfaces/ip route ...)",
  usage: "show <object> ...",
  help: [
    "SHOW (SONiC)",
    "",
    "Usage:",
    "  show vlan | show vlan brief | show vlan <id>",
    "  show interfaces status | show ip interfaces | show mac",
    "  show ip route | show arp | show running-config",
    "",
    "Renders live simulated state.",
  ],
  run(args, ctx): CommandResult {
    if (args.length === 0) return { output: usageList(SHOW_CMDS, "show") };
    const m = matchSonic(SHOW_CMDS, args);
    if (!m) {
      return {
        output: [err(`show: unknown command '${args.join(" ")}'`), ...usageList(SHOW_CMDS, "show")],
      };
    }
    return m.cmd.run(m.rest, ctx);
  },
};
