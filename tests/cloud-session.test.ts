import { describe, it, expect, beforeEach } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  saveSwitchSnapshot,
  listSwitchSnapshots,
} from "../lib/firebase/session-service";
import { generateSonicRunningConfig } from "../lib/sonic/config-export";
import { featureState } from "../lib/models/feature-state";
import { isSwitch } from "../lib/models/device";

describe("Cloud & Firebase Session Support for Switches", () => {
  beforeEach(() => {
    useLabStore.getState().newLab();
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
  });

  it("extracts and formats SONiC running-config for a switch", () => {
    const store = useLabStore.getState();
    const swId = store.addDevice("switch", { x: 100, y: 100 }, 4);
    const initialSw = useLabStore.getState().network.devices[swId];

    // Configure VLAN on switch
    store.setAccessVlan(swId, initialSw.interfaces[0].id, 10);
    // Configure IP on mgmt or interface
    store.setInterfaceIp(swId, initialSw.interfaces[1].id, "10.0.0.1", 24);

    // Set BGP feature config on latest switch state
    const currentSw = useLabStore.getState().network.devices[swId];
    const bgp = featureState(currentSw, "bgp", () => ({
      localAs: 65100,
      routerId: "10.0.0.1",
      neighbors: [{ ip: "10.0.0.2", remoteAs: 65200 }],
      networks: ["10.0.0.0/24"],
    }));
    expect(bgp.localAs).toBe(65100);

    const cfgText = generateSonicRunningConfig(currentSw);
    expect(cfgText).toContain("hostname");
    expect(cfgText).toContain("interface Ethernet0");
    expect(cfgText).toContain("switchport mode access");
    expect(cfgText).toContain("switchport access vlan 10");
    expect(cfgText).toContain("router bgp 65100");
    expect(cfgText).toContain("neighbor 10.0.0.2 remote-as 65200");
  });

  it("saves a lab session and lists it with switch summaries", async () => {
    const store = useLabStore.getState();
    const sw1 = store.addDevice("switch", { x: 200, y: 200 }, 4);
    const pc1 = store.addDevice("pc", { x: 50, y: 100 });
    store.connect(pc1, `${pc1}-if0`, sw1, `${sw1}-if0`);
    store.setAccessVlan(sw1, `${sw1}-if0`, 20);

    const res = await store.saveToCloud("Multi-Switch Data Center");
    expect(res.ok).toBe(true);
    expect(res.id).toBeDefined();

    const list = await listSessions();
    expect(list.length).toBeGreaterThan(0);
    const entry = list.find((s) => s.id === res.id);
    expect(entry).toBeDefined();
    expect(entry?.name).toBe("Multi-Switch Data Center");
    expect(entry?.switchCount).toBe(1);
    expect(entry?.switchesSummary[0].vlans).toContain(20);
  });

  it("reopens a saved session and restores switch configurations to continue working", async () => {
    const store = useLabStore.getState();
    const sw1 = store.addDevice("switch", { x: 300, y: 300 }, 4);
    store.renameDevice(sw1, "Leaf-Switch-01");
    store.setInterfaceIp(sw1, `${sw1}-if1`, "172.16.1.1", 24);
    store.setAccessVlan(sw1, `${sw1}-if0`, 50);

    // Run a command to create terminal history
    store.appendTerminal(sw1, [{ text: "show version", kind: "input" }, { text: "SONiC.202411", kind: "output" }]);

    const saveRes = await store.saveToCloud("Leaf-01 Production");
    expect(saveRes.ok).toBe(true);
    const sessionId = saveRes.id!;

    // Now clear the lab (simulate closing or starting a new lab)
    store.newLab();
    expect(Object.keys(useLabStore.getState().network.devices).length).toBe(0);

    // Reopen the session from cloud
    const loadRes = await store.loadFromCloud(sessionId);
    expect(loadRes.ok).toBe(true);

    const restoredState = useLabStore.getState();
    expect(restoredState.labName).toBe("Leaf-01 Production");
    expect(restoredState.currentSessionId).toBe(sessionId);

    // Verify switch is restored with exact configuration
    const restoredSw = restoredState.network.devices[sw1];
    expect(restoredSw).toBeDefined();
    expect(restoredSw.name).toBe("Leaf-Switch-01");
    expect(isSwitch(restoredSw.type)).toBe(true);

    // Verify interface IP
    const if1 = restoredSw.interfaces.find((i) => i.id === `${sw1}-if1`);
    expect(if1?.ipv4[0]?.address).toBe("172.16.1.1");

    // Verify VLAN configuration
    const if0 = restoredSw.interfaces.find((i) => i.id === `${sw1}-if0`);
    expect(if0?.vlan.accessVlan).toBe(50);

    // Verify terminal lines are restored
    const lines = restoredState.terminals[sw1];
    expect(lines).toBeDefined();
    expect(lines?.some((l) => l.text.includes("SONiC.202411"))).toBe(true);
  });

  it("restores the last active session when the user returns (restoreLastSession)", async () => {
    const store = useLabStore.getState();
    const sw = store.addDevice("switch", { x: 150, y: 150 }, 4);
    store.renameDevice(sw, "CoreSwitch");

    const saveRes = await store.saveToCloud("Active Session Return Test");
    expect(saveRes.ok).toBe(true);

    // Clear store state without clearing localStorage active session key
    useLabStore.setState({ network: { devices: {}, connections: [] }, currentSessionId: null });
    expect(Object.keys(useLabStore.getState().network.devices).length).toBe(0);

    // Simulate returning to the page
    const restored = await useLabStore.getState().restoreLastSession();
    expect(restored).toBe(true);

    const state = useLabStore.getState();
    expect(state.currentSessionId).toBe(saveRes.id);
    expect(state.network.devices[sw]?.name).toBe("CoreSwitch");
  });

  it("supports standalone switch snapshots and templates", async () => {
    const store = useLabStore.getState();
    const sw = store.addDevice("switch", { x: 100, y: 100 }, 4);
    store.renameDevice(sw, "TemplateSwitch");
    const dev = useLabStore.getState().network.devices[sw];

    const snapshot = await saveSwitchSnapshot(dev, "Spine Switch 40G Template");
    expect(snapshot.id).toBeDefined();
    expect(snapshot.name).toBe("Spine Switch 40G Template");
    expect(snapshot.hostname).toBe("TemplateSwitch");

    const all = await listSwitchSnapshots();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((s) => s.id === snapshot.id)).toBe(true);
  });

  it("deletes a session cleanly from cloud", async () => {
    const store = useLabStore.getState();
    store.addDevice("switch", { x: 10, y: 10 }, 4);
    const saveRes = await store.saveToCloud("Temporary Session To Delete");
    const sessionId = saveRes.id!;

    const delRes = await store.deleteFromCloud(sessionId);
    expect(delRes.ok).toBe(true);

    const check = await loadSession(sessionId);
    expect(check).toBeNull();
  });
});
