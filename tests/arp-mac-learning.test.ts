import { describe, it, expect, beforeEach } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import { normalizeMac, isValidMac, isUnicast } from "../lib/models/mac";
import { resetMacCounter } from "../lib/models/factory";
import { resolveArp } from "../lib/protocols/arp";
import { Simulation } from "../lib/engine";

describe("ARP and MAC Learning Engine", () => {
  beforeEach(() => {
    resetMacCounter(1);
    const store = useLabStore.getState();
    store.newLab();
  });

  describe("MAC Address normalization and validation", () => {
    it("handles diverse MAC address formats and casing", () => {
      expect(normalizeMac("02:00:00:aa:bb:cc")).toBe("02:00:00:AA:BB:CC");
      expect(normalizeMac("02-00-00-aa-bb-cc")).toBe("02:00:00:AA:BB:CC");
      expect(normalizeMac("0200.00aa.bbcc")).toBe("02:00:00:AA:BB:CC");
      expect(normalizeMac("020000aabbcc")).toBe("02:00:00:AA:BB:CC");
    });

    it("correctly identifies valid unicast MAC addresses", () => {
      expect(isValidMac("02:00:00:AA:BB:CC")).toBe(true);
      expect(isValidMac("02-00-00-AA-BB-CC")).toBe(true);
      expect(isValidMac("0200.00aa.bbcc")).toBe(true);
      expect(isValidMac("invalid-mac")).toBe(false);

      expect(isUnicast("02:00:00:AA:BB:CC")).toBe(true);
      // Broadcast is not unicast
      expect(isUnicast("FF:FF:FF:FF:FF:FF")).toBe(false);
      // Multicast bit set in first octet (e.g. 01:00:5e:00:00:01) is not unicast
      expect(isUnicast("01:00:5E:00:00:01")).toBe(false);
      // All zero null MAC is not unicast
      expect(isUnicast("00:00:00:00:00:00")).toBe(false);
    });
  });

  describe("MAC assignment and Gratuitous ARP", () => {
    it("assigns MAC to an interface via store and validates input", () => {
      const store = useLabStore.getState();
      const pcId = store.addDevice("pc", { x: 100, y: 100 });
      const dev = useLabStore.getState().network.devices[pcId];
      const ifaceId = dev.interfaces[0].id;

      // Invalid MAC rejected
      const errRes = store.setInterfaceMac(pcId, ifaceId, "invalid-mac");
      expect(errRes.ok).toBe(false);

      // Multicast MAC rejected for interface hardware address
      const mcRes = store.setInterfaceMac(pcId, ifaceId, "01:00:5E:00:00:01");
      expect(mcRes.ok).toBe(false);

      // Valid unicast MAC accepted and normalized
      const okRes = store.setInterfaceMac(pcId, ifaceId, "02:11:22:aa:bb:cc");
      expect(okRes.ok).toBe(true);

      const updatedDev = useLabStore.getState().network.devices[pcId];
      expect(updatedDev.interfaces[0].mac).toBe("02:11:22:AA:BB:CC");
    });

    it("emits Gratuitous ARP on MAC change when interface is UP with IP", () => {
      const store = useLabStore.getState();
      const pc1 = store.addDevice("pc", { x: 100, y: 100 });
      const sw1 = store.addDevice("switch", { x: 300, y: 100 }, 4);

      const pcDev = useLabStore.getState().network.devices[pc1];
      const swDev = useLabStore.getState().network.devices[sw1];

      store.connect(pc1, pcDev.interfaces[0].id, sw1, swDev.interfaces[0].id);
      store.setInterfaceIp(pc1, pcDev.interfaces[0].id, "192.168.1.10", 24);

      // Baseline control tick initializes daemon signature
      store.controlTick();

      // Change PC1 MAC
      store.setInterfaceMac(pc1, pcDev.interfaces[0].id, "02:AA:BB:CC:DD:EE");

      // Switch should now have learned PC1's new MAC on port Ethernet0 in VLAN 1
      const updatedSw = useLabStore.getState().network.devices[sw1];
      const learned = updatedSw.macTable.find((e) => normalizeMac(e.mac) === "02:AA:BB:CC:DD:EE");
      expect(learned).toBeDefined();
      expect(learned?.interfaceId).toBe(swDev.interfaces[0].id);
    });
  });

  describe("ARP Resolution and Learning between Devices", () => {
    it("learns ARP entry as reachable when ARP reply is received", () => {
      const store = useLabStore.getState();
      const pc1 = store.addDevice("pc", { x: 100, y: 100 });
      const pc2 = store.addDevice("pc", { x: 300, y: 100 });

      const pc1Dev = useLabStore.getState().network.devices[pc1];
      const pc2Dev = useLabStore.getState().network.devices[pc2];

      store.connect(pc1, pc1Dev.interfaces[0].id, pc2, pc2Dev.interfaces[0].id);
      store.setInterfaceIp(pc1, pc1Dev.interfaces[0].id, "192.168.1.10", 24);
      store.setInterfaceIp(pc2, pc2Dev.interfaces[0].id, "192.168.1.20", 24);

      // Trigger resolution from PC1 to PC2
      const sim = new Simulation(useLabStore.getState().network);
      const curPc1 = sim.state.devices[pc1];
      const resolvedMac = resolveArp(sim, curPc1, curPc1.interfaces[0], "192.168.1.20");

      expect(resolvedMac).toBe(pc2Dev.interfaces[0].mac);

      // PC1 ARP cache should have PC2 reachable
      const entry = curPc1.arpTable.find((e) => e.ip === "192.168.1.20");
      expect(entry).toBeDefined();
      expect(entry?.state).toBe("reachable");
      expect(entry?.mac).toBe(pc2Dev.interfaces[0].mac);
    });

    it("switch SVI learns host ARP and host learns SVI ARP through switchports", () => {
      const store = useLabStore.getState();
      const pc1 = store.addDevice("pc", { x: 100, y: 100 });
      const sw1 = store.addDevice("switch", { x: 300, y: 100 }, 4);

      const pcDev = useLabStore.getState().network.devices[pc1];
      const swDev = useLabStore.getState().network.devices[sw1];

      store.connect(pc1, pcDev.interfaces[0].id, sw1, swDev.interfaces[0].id);
      store.setInterfaceIp(pc1, pcDev.interfaces[0].id, "192.168.1.10", 24);

      // Configure SVI Vlan1 on switch
      const svi = {
        id: `${sw1}-vlan1`,
        name: "Vlan1",
        mac: "02:00:00:55:00:01",
        adminState: "up" as const,
        operState: "up" as const,
        speed: 1000,
        duplex: "full" as const,
        mtu: 1500,
        management: false,
        logical: true,
        ipv4: [{ address: "192.168.1.1", prefix: 24 }],
        ipv6: [],
        vlan: { mode: "access" as const, accessVlan: 1, nativeVlan: 1, allowedVlans: [1] },
        statistics: { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, rxDropped: 0, txDropped: 0 },
      };

      const nextNet = structuredClone(useLabStore.getState().network);
      nextNet.devices[sw1].interfaces.push(svi);

      const sim = new Simulation(nextNet);
      const curPc = sim.state.devices[pc1];

      // PC resolves switch SVI IP
      const resolvedMac = resolveArp(sim, curPc, curPc.interfaces[0], "192.168.1.1");
      expect(resolvedMac).toBe("02:00:00:55:00:01");

      const pcArpEntry = curPc.arpTable.find((e) => e.ip === "192.168.1.1");
      expect(pcArpEntry?.state).toBe("reachable");
      expect(pcArpEntry?.mac).toBe("02:00:00:55:00:01");

      // Switch SVI should have also learned PC1
      const curSw = sim.state.devices[sw1];
      const swArpEntry = curSw.arpTable.find((e) => e.ip === "192.168.1.10");
      expect(swArpEntry).toBeDefined();
      expect(swArpEntry?.mac).toBe(pcDev.interfaces[0].mac);

      // Switch L2 MAC table should also have learned PC1 on Ethernet0
      const macEntry = curSw.macTable.find((m) => normalizeMac(m.mac) === normalizeMac(pcDev.interfaces[0].mac));
      expect(macEntry).toBeDefined();
      expect(macEntry?.interfaceId).toBe(swDev.interfaces[0].id);
    });
  });

  describe("CLI Commands: ip and arp", () => {
    it("supports ip link set address to change MAC", () => {
      const store = useLabStore.getState();
      const pc1 = store.addDevice("pc", { x: 100, y: 100 });

      // Change MAC via CLI
      const res = store.execCommand(pc1, "ip link set eth0 address 02:00:00:77:88:99");
      expect(res.output.some((l) => l.text.includes("02:00:00:77:88:99"))).toBe(true);

      const updated = useLabStore.getState().network.devices[pc1];
      expect(updated.interfaces[0].mac).toBe("02:00:00:77:88:99");
    });

    it("supports ip neigh add, replace, and del", () => {
      const store = useLabStore.getState();
      const pc1 = store.addDevice("pc", { x: 100, y: 100 });

      // Add static neighbour
      const addRes = store.execCommand(pc1, "ip neigh add 10.0.0.50 lladdr 02:00:00:11:22:33 dev eth0");
      expect(addRes.output.some((l) => l.text.includes("static neighbour"))).toBe(true);

      let dev = useLabStore.getState().network.devices[pc1];
      let entry = dev.arpTable.find((e) => e.ip === "10.0.0.50");
      expect(entry?.mac).toBe("02:00:00:11:22:33");

      // Replace static neighbour
      const repRes = store.execCommand(pc1, "ip neigh replace 10.0.0.50 lladdr 02:00:00:44:55:66 dev eth0");
      expect(repRes.output.some((l) => l.text.includes("static neighbour"))).toBe(true);

      dev = useLabStore.getState().network.devices[pc1];
      entry = dev.arpTable.find((e) => e.ip === "10.0.0.50");
      expect(entry?.mac).toBe("02:00:00:44:55:66");

      // Delete neighbour
      const delRes = store.execCommand(pc1, "ip neigh del 10.0.0.50");
      expect(delRes.output.some((l) => l.text.includes("deleted entry"))).toBe(true);

      dev = useLabStore.getState().network.devices[pc1];
      expect(dev.arpTable.find((e) => e.ip === "10.0.0.50")).toBeUndefined();
    });

    it("supports arp -s and arp -d commands", () => {
      const store = useLabStore.getState();
      const pc1 = store.addDevice("pc", { x: 100, y: 100 });

      // arp -s
      const sRes = store.execCommand(pc1, "arp -s 10.0.0.60 02:00:00:aa:bb:cc");
      expect(sRes.output.some((l) => l.text.includes("Added static ARP entry"))).toBe(true);

      let dev = useLabStore.getState().network.devices[pc1];
      expect(dev.arpTable.some((e) => e.ip === "10.0.0.60" && e.mac === "02:00:00:AA:BB:CC")).toBe(true);

      // arp -d
      const dRes = store.execCommand(pc1, "arp -d 10.0.0.60");
      expect(dRes.output.some((l) => l.text.includes("Deleted ARP entry"))).toBe(true);

      dev = useLabStore.getState().network.devices[pc1];
      expect(dev.arpTable.some((e) => e.ip === "10.0.0.60")).toBe(false);
    });

    it("supports SONiC CLI config mac add, del, clear", () => {
      const store = useLabStore.getState();
      const sw1 = store.addDevice("switch", { x: 100, y: 100 }, 4);

      // Drop from modal KLISH to Linux/Click bash shell
      store.execCommand(sw1, "exit");

      // config mac add
      const addRes = store.execCommand(sw1, "config mac add 10 02:00:00:12:34:56 Ethernet0");
      expect(addRes.output.some((l) => l.text.includes("Added MAC"))).toBe(true);

      let sw = useLabStore.getState().network.devices[sw1];
      expect(sw.macTable.some((m) => m.vlan === 10 && m.mac === "02:00:00:12:34:56")).toBe(true);

      // config mac del
      const delRes = store.execCommand(sw1, "config mac del 10 02:00:00:12:34:56");
      expect(delRes.output.some((l) => l.text.includes("Deleted MAC"))).toBe(true);

      sw = useLabStore.getState().network.devices[sw1];
      expect(sw.macTable.some((m) => m.vlan === 10 && m.mac === "02:00:00:12:34:56")).toBe(false);
    });
  });
});
