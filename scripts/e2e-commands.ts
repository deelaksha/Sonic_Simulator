/**
 * Headless driver exercising the terminal command layer against PC1—SW1—PC2.
 * Run with: npx tsx scripts/e2e-commands.ts
 */
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, CaptureRecord, SimEvent, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";

resetMacCounter(1);
resetIds();

const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
pc1.interfaces[0].ipv4 = [{ address: "192.168.1.10", prefix: 24 }];
pc2.interfaces[0].ipv4 = [{ address: "192.168.1.20", prefix: 24 }];
rebuildConnectedRoutes(pc1);
rebuildConnectedRoutes(pc2);

const state: NetworkState = { devices: { pc1, pc2, sw1 }, connections: [] };
linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });

const captures: CaptureRecord[] = [];
function ctxFor(device: Device): CommandContext {
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (sim: Simulation) => T): { value: T; events: SimEvent[] } {
      const sim = new Simulation(state);
      const value = fn(sim);
      captures.push(...sim.captures);
      return { value, events: sim.events };
    },
  };
}

function run(device: Device, cmd: string) {
  console.log(`\n${device.config.hostname}$ ${cmd}`);
  const res = execute(cmd, ctxFor(device));
  for (const l of res.output) console.log("  " + l.text);
}

run(pc1, "ip addr");
run(pc1, "ip route");
run(pc1, "ping -c 2 192.168.1.20");
run(pc1, "ip neigh");
run(pc1, "arp -a");
run(pc1, "tcpdump -i eth0 icmp");
run(pc1, "traceroute 192.168.1.20");
run(pc1, "ping 192.168.1.99"); // ARP fails: unreachable in-subnet host
run(pc1, "ping 10.0.0.1"); // no route
run(pc1, "help ping");
