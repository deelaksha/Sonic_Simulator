/** Shared topology builders for the engine tests. */
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { resetIds } from "../lib/engine";
import { Device } from "../lib/models/device";

export function resetAll(): void {
  resetMacCounter(1);
  resetIds();
}

function ip(dev: Device, ifIdx: number, address: string, prefix: number): void {
  dev.interfaces[ifIdx].ipv4 = [{ address, prefix }];
}

/** PC1 ── SW1 ── PC2, both in 192.168.1.0/24 (spec §55). */
export function lan2(): { state: NetworkState; pc1: Device; pc2: Device; sw1: Device } {
  resetAll();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  ip(pc1, 0, "192.168.1.10", 24);
  ip(pc2, 0, "192.168.1.20", 24);
  rebuildConnectedRoutes(pc1);
  rebuildConnectedRoutes(pc2);
  const state: NetworkState = { devices: { pc1, pc2, sw1 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
  linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });
  return { state, pc1, pc2, sw1 };
}

/** PC1 ── R1 ── PC2 across two subnets (spec §56, §62). */
export function routed(): { state: NetworkState; pc1: Device; pc2: Device; r1: Device } {
  resetAll();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
  const r1 = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 2 });
  ip(pc1, 0, "192.168.1.10", 24);
  ip(r1, 0, "192.168.1.1", 24);
  ip(r1, 1, "192.168.2.1", 24);
  ip(pc2, 0, "192.168.2.10", 24);
  pc1.config.defaultGateway = "192.168.1.1";
  pc2.config.defaultGateway = "192.168.2.1";
  [pc1, pc2, r1].forEach(rebuildConnectedRoutes);
  const state: NetworkState = { devices: { pc1, pc2, r1 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "r1", interfaceId: "r1-if0" });
  linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "r1", interfaceId: "r1-if1" });
  return { state, pc1, pc2, r1 };
}
