import { describe, it, expect, beforeEach } from "vitest";
import { useLabStore } from "../lib/store/lab-store";

function mgmtIp(deviceId: string): string | undefined {
  const dev = useLabStore.getState().network.devices[deviceId];
  return dev?.interfaces.find((i) => i.management)?.ipv4[0]?.address;
}

describe("switch out-of-band management IP", () => {
  beforeEach(() => useLabStore.getState().newLab());

  it("gives each switch a distinct mgmt IP in 192.168.100.0/24", () => {
    const add = () => useLabStore.getState().addDevice("switch", { x: 0, y: 0 }, 4);
    const s1 = add();
    const s2 = add();
    const s3 = add();
    expect(mgmtIp(s1)).toBe("192.168.100.1");
    expect(mgmtIp(s2)).toBe("192.168.100.2");
    expect(mgmtIp(s3)).toBe("192.168.100.3");
    expect(new Set([mgmtIp(s1), mgmtIp(s2), mgmtIp(s3)]).size).toBe(3);
  });

  it("reuses the smallest freed host after a switch is removed", () => {
    const store = useLabStore.getState();
    store.addDevice("switch", { x: 0, y: 0 }, 4); // .1
    const s2 = store.addDevice("switch", { x: 0, y: 0 }, 4); // .2
    store.addDevice("switch", { x: 0, y: 0 }, 4); // .3
    store.removeDevice(s2); // frees .2
    const s4 = store.addDevice("switch", { x: 0, y: 0 }, 4);
    expect(mgmtIp(s4)).toBe("192.168.100.2");
  });

  it("does not assign a mgmt IP to PCs (they stay in normal mode)", () => {
    const pc = useLabStore.getState().addDevice("pc", { x: 0, y: 0 });
    const dev = useLabStore.getState().network.devices[pc];
    expect(dev.interfaces.some((i) => i.management)).toBe(false);
  });
});
