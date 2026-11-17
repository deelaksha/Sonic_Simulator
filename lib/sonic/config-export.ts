/**
 * Formats a switch's current state and features into a readable SONiC running-config
 */
import { Device, isSwitch } from "../models/device";
import { peekFeatureState } from "../models/feature-state";

export function generateSonicRunningConfig(device: Device): string {
  if (!isSwitch(device.type)) {
    return `# Running configuration for ${device.name} (${device.type})\nhostname ${device.config.hostname || device.name}\n`;
  }

  const lines: string[] = [];
  lines.push(`! SONiC Switch Running Configuration`);
  lines.push(`! Device: ${device.name} (${device.id})`);
  lines.push(`! Current State: ${device.state.toUpperCase()}`);
  lines.push(`! Time: ${new Date().toISOString()}`);
  lines.push(`!`);
  lines.push(`hostname ${device.config.hostname || device.name}`);
  lines.push(`!`);

  // VLAN database
  const vlans = device.config.vlans || [];
  if (vlans.length > 0) {
    lines.push(`! --- VLAN Configuration ---`);
    for (const vlan of vlans) {
      lines.push(`vlan ${vlan.id}`);
      if (vlan.name) {
        lines.push(`  description ${vlan.name}`);
      }
    }
    lines.push(`!`);
  }

  // Interfaces
  lines.push(`! --- Interface Configuration ---`);
  for (const iface of device.interfaces) {
    lines.push(`interface ${iface.name}`);
    if (iface.adminState === "down") {
      lines.push(`  shutdown`);
    } else {
      lines.push(`  no shutdown`);
    }

    if (iface.vlan.mode === "access") {
      lines.push(`  switchport mode access`);
      if (iface.vlan.accessVlan) {
        lines.push(`  switchport access vlan ${iface.vlan.accessVlan}`);
      }
    } else if (iface.vlan.mode === "trunk") {
      lines.push(`  switchport mode trunk`);
      if (iface.vlan.nativeVlan) {
        lines.push(`  switchport trunk native vlan ${iface.vlan.nativeVlan}`);
      }
      if (iface.vlan.allowedVlans && iface.vlan.allowedVlans.length > 0) {
        lines.push(`  switchport trunk allowed vlan ${iface.vlan.allowedVlans.join(",")}`);
      }
    }

    for (const ip of iface.ipv4) {
      lines.push(`  ip address ${ip.address}/${ip.prefix}`);
    }
    for (const ip6 of iface.ipv6) {
      lines.push(`  ipv6 address ${ip6.address}/${ip6.prefix}`);
    }
    lines.push(`!`);
  }

  // BGP
  const bgp = peekFeatureState<{
    localAs?: number;
    routerId?: string;
    neighbors?: Array<{ ip: string; remoteAs: number; description?: string }>;
    networks?: string[];
  }>(device, "bgp");

  if (bgp && bgp.localAs) {
    lines.push(`! --- BGP Routing ---`);
    lines.push(`router bgp ${bgp.localAs}`);
    if (bgp.routerId) {
      lines.push(`  router-id ${bgp.routerId}`);
    }
    if (bgp.neighbors) {
      for (const n of bgp.neighbors) {
        lines.push(`  neighbor ${n.ip} remote-as ${n.remoteAs}`);
        if (n.description) lines.push(`  neighbor ${n.ip} description ${n.description}`);
      }
    }
    if (bgp.networks) {
      for (const net of bgp.networks) {
        lines.push(`  network ${net}`);
      }
    }
    lines.push(`!`);
  }

  // OSPF
  const ospf = peekFeatureState<{
    routerId?: string;
    areas?: Array<{ area: string; networks: string[] }>;
  }>(device, "ospf");

  if (ospf) {
    lines.push(`! --- OSPF Routing ---`);
    lines.push(`router ospf`);
    if (ospf.routerId) {
      lines.push(`  router-id ${ospf.routerId}`);
    }
    if (ospf.areas) {
      for (const a of ospf.areas) {
        for (const net of a.networks) {
          lines.push(`  network ${net} area ${a.area}`);
        }
      }
    }
    lines.push(`!`);
  }

  // LLDP
  const lldp = peekFeatureState<{ enabled?: boolean; holdtime?: number }>(device, "lldp");
  if (lldp && lldp.enabled !== false) {
    lines.push(`! --- LLDP ---`);
    lines.push(`lldp run`);
    if (lldp.holdtime) lines.push(`lldp holdtime ${lldp.holdtime}`);
    lines.push(`!`);
  }

  // SNMP
  const snmp = peekFeatureState<{
    communities?: Array<{ name: string; mode?: string }>;
    location?: string;
    contact?: string;
  }>(device, "snmp");
  if (snmp) {
    lines.push(`! --- SNMP Configuration ---`);
    if (snmp.communities) {
      for (const c of snmp.communities) {
        lines.push(`snmp-server community ${c.name} ${c.mode || "ro"}`);
      }
    }
    if (snmp.location) lines.push(`snmp-server location ${snmp.location}`);
    if (snmp.contact) lines.push(`snmp-server contact ${snmp.contact}`);
    lines.push(`!`);
  }

  // Routing Table Static Routes
  const staticRoutes = device.routingTable.filter((r) => r.type === "static" || r.type === "default");
  if (staticRoutes.length > 0) {
    lines.push(`! --- Static Routes ---`);
    for (const r of staticRoutes) {
      if (r.nextHop) {
        lines.push(`ip route ${r.destination}/${r.prefix} ${r.nextHop}`);
      }
    }
    lines.push(`!`);
  }

  lines.push(`end`);
  return lines.join("\n");
}
