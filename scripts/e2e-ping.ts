/**
 * Headless end-to-end driver for the MVP-1 acceptance flow (spec §55):
 *   PC1 ── SW1 ── PC2, configure IPs, ping across it.
 * Run with: npm run sim
 */
import { createDevice, rebuildConnectedRoutes } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { resetMacCounter } from "../lib/models/factory";
import { resetIds } from "../lib/engine/ids";
import { simulatePing } from "../lib/engine";
import { describeFrame } from "../lib/models/packet";

resetMacCounter(1);
resetIds();

const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });

pc1.interfaces[0].ipv4 = [{ address: "192.168.1.10", prefix: 24 }];
pc2.interfaces[0].ipv4 = [{ address: "192.168.1.20", prefix: 24 }];
rebuildConnectedRoutes(pc1);
rebuildConnectedRoutes(pc2);

const state: NetworkState = {
  devices: { pc1, pc2, sw1 },
  connections: [],
};

linkInterfaces(
  state,
  { deviceId: "pc1", interfaceId: "pc1-if0" },
  { deviceId: "sw1", interfaceId: "sw1-if0" },
);
linkInterfaces(
  state,
  { deviceId: "pc2", interfaceId: "pc2-if0" },
  { deviceId: "sw1", interfaceId: "sw1-if1" },
);

console.log("=== PC1 routing table ===");
for (const r of pc1.routingTable) {
  console.log(`  ${r.destination}/${r.prefix} ${r.nextHop ?? "(connected)"} type=${r.type}`);
}

console.log("\n=== ping 192.168.1.20 (from PC1) ===");
const { summary, events } = simulatePing(state, "pc1", "192.168.1.20", { count: 2 });

console.log("\n--- Event timeline ---");
for (const e of events) {
  console.log(`  [${String(e.timeMs).padStart(3)}ms] ${e.type.padEnd(18)} ${e.message}`);
}

console.log("\n--- Ping result ---");
for (const r of summary.replies) {
  if (r.success) {
    console.log(`  ${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs} ms`);
  } else {
    console.log(`  seq=${r.seq} FAILED (${r.reason})`);
  }
}
console.log(`  ${summary.transmitted} transmitted, ${summary.received} received`);

console.log("\n=== SW1 MAC address table ===");
for (const m of sw1.macTable) {
  console.log(`  ${m.mac}  ${m.interfaceId}  vlan=${m.vlan}`);
}

console.log("\n=== PC1 ARP table ===");
for (const a of pc1.arpTable) {
  console.log(`  ${a.ip} -> ${a.mac} (${a.state})`);
}

console.log("\n=== Inspect first ICMP echo request frame ===");
const echo = events.find((e) => e.type === "IP_PACKET_CREATED" && e.frame?.icmp?.type === "echo-request");
if (echo?.frame) {
  for (const layer of describeFrame(echo.frame)) {
    console.log(`  L${layer.osiLayer} ${layer.title}`);
    for (const f of layer.fields) console.log(`      ${f.label}: ${f.value}`);
  }
}
