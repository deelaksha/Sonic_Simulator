/**
 * VLAN configuration operations (task §22). Pure mutations over the EXISTING
 * switch state (interface.vlan + config.vlans) — the same fields the packet
 * engine already uses for 802.1Q classify/forward, so `config vlan ...` changes
 * real forwarding behavior (single source of truth).
 */
import { Device, interfaceByName } from "./device";
import { Vlan, DEFAULT_VLAN } from "./vlan";

export interface OpResult {
  ok: boolean;
  error?: string;
}

export function listVlans(device: Device): Vlan[] {
  return device.config.vlans ?? [];
}

function vlansOf(device: Device): Vlan[] {
  if (!device.config.vlans) device.config.vlans = [];
  return device.config.vlans;
}

export function addVlan(device: Device, id: number): OpResult {
  if (!Number.isInteger(id) || id < 2 || id > 4094) {
    return { ok: false, error: `Invalid VLAN ID ${id} (valid range 2-4094)` };
  }
  const vlans = vlansOf(device);
  if (vlans.some((v) => v.id === id)) return { ok: true }; // idempotent
  vlans.push({ id, name: `Vlan${id}` });
  return { ok: true };
}

export function delVlan(device: Device, id: number): OpResult {
  const vlans = vlansOf(device);
  if (!vlans.some((v) => v.id === id)) return { ok: true }; // clean no-op
  // detach from all ports
  for (const iface of device.interfaces) {
    if (iface.vlan.mode === "access" && iface.vlan.accessVlan === id) iface.vlan.accessVlan = DEFAULT_VLAN;
    iface.vlan.allowedVlans = iface.vlan.allowedVlans.filter((v) => v !== id);
  }
  device.config.vlans = vlans.filter((v) => v.id !== id);
  return { ok: true };
}

export function addMember(device: Device, id: number, portName: string, tagged: boolean): OpResult {
  if (!vlansOf(device).some((v) => v.id === id)) {
    return { ok: false, error: `VLAN ${id} does not exist (create it with 'config vlan add ${id}')` };
  }
  const iface = interfaceByName(device, portName);
  if (!iface) return { ok: false, error: `Invalid interface ${portName}` };
  // A port may be an untagged member of one VLAN and a tagged member of others
  // (VLAN_MEMBER rows are independent): the untagged VLAN is the trunk's native VLAN.
  if (tagged) {
    if (iface.vlan.mode === "access" && iface.vlan.accessVlan !== DEFAULT_VLAN) {
      iface.vlan.nativeVlan = iface.vlan.accessVlan;
      if (!iface.vlan.allowedVlans.includes(iface.vlan.accessVlan)) iface.vlan.allowedVlans.push(iface.vlan.accessVlan);
    }
    iface.vlan.mode = "trunk";
    if (iface.vlan.nativeVlan === DEFAULT_VLAN && !iface.vlan.allowedVlans.includes(DEFAULT_VLAN)) {
      // keep native as-is
    }
    if (!iface.vlan.allowedVlans.includes(id)) iface.vlan.allowedVlans.push(id);
  } else if (iface.vlan.mode === "trunk") {
    // Untagged member on a trunk port: replaces the native VLAN, tagged VLANs stay.
    const old = iface.vlan.nativeVlan;
    if (old !== DEFAULT_VLAN) iface.vlan.allowedVlans = iface.vlan.allowedVlans.filter((v) => v !== old);
    iface.vlan.accessVlan = id;
    iface.vlan.nativeVlan = id;
    if (!iface.vlan.allowedVlans.includes(id)) iface.vlan.allowedVlans.push(id);
  } else {
    iface.vlan.mode = "access";
    iface.vlan.accessVlan = id;
  }
  return { ok: true };
}

export function delMember(device: Device, id: number, portName: string): OpResult {
  const iface = interfaceByName(device, portName);
  if (!iface) return { ok: false, error: `Invalid interface ${portName}` };
  if (iface.vlan.mode === "access" && iface.vlan.accessVlan === id) iface.vlan.accessVlan = DEFAULT_VLAN;
  if (iface.vlan.mode === "trunk" && iface.vlan.nativeVlan === id && id !== DEFAULT_VLAN) {
    iface.vlan.nativeVlan = DEFAULT_VLAN;
    iface.vlan.accessVlan = DEFAULT_VLAN;
  }
  iface.vlan.allowedVlans = iface.vlan.allowedVlans.filter((v) => v !== id);
  return { ok: true };
}

export interface VlanMember {
  port: string;
  tagged: boolean;
}

export function vlanMembers(device: Device, id: number): VlanMember[] {
  const members: VlanMember[] = [];
  for (const iface of device.interfaces) {
    if (iface.vlan.mode === "access" && iface.vlan.accessVlan === id) {
      members.push({ port: iface.name, tagged: false });
    } else if (iface.vlan.mode === "trunk" && iface.vlan.allowedVlans.includes(id)) {
      members.push({ port: iface.name, tagged: id !== iface.vlan.nativeVlan });
    }
  }
  return members;
}
