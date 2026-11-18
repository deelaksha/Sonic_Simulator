import { describe, it, expect } from "vitest";
import { decodeEvpnNlri, encodeEvpnNlri, encodeRd, decodeRd, ecRt, ecEncap, ecMacMobility, ecListStr, sortEcs, evpnPrefixStr, EvpnRoute } from "../lib/protocols/evpn-wire";
import { decodeMessages, encodeEvpnUpdate, UpdateMsg } from "../lib/protocols/bgp-wire";
import { tabGrid, tabSimple } from "../lib/protocols/vxlan-cli";

describe("EVPN NLRI / attribute codec (FRR bgp_evpn_encode_prefix layout)", () => {
  const t2: EvpnRoute = { type: 2, rd: "10.0.0.1:2", ethTag: 0, mac: "02:00:00:00:00:10", vni: 10100 };
  const t2ip: EvpnRoute = { ...t2, ip: "172.16.100.11" };
  const t3: EvpnRoute = { type: 3, rd: "10.0.0.2:3", ethTag: 0, origIp: "10.0.0.2" };

  it("type-2 is 33 bytes (37 with an IPv4), type-3 is 17; round-trips", () => {
    const b2 = encodeEvpnNlri(t2);
    expect(b2.slice(0, 2)).toEqual([2, 33]);
    expect(b2.slice(2, 10)).toEqual([0, 1, 10, 0, 0, 1, 0, 2]); // RD type 1 IP:nn
    expect(b2.slice(10, 20)).toEqual(new Array(10).fill(0)); // ESI
    expect(b2.slice(-3)).toEqual([0x00, 0x27, 0x74]); // VNI 10100 as the 3-byte label
    expect(encodeEvpnNlri(t2ip)[1]).toBe(37);
    expect(encodeEvpnNlri(t3).slice(0, 2)).toEqual([3, 17]);
    const all = Uint8Array.from([...b2, ...encodeEvpnNlri(t2ip), ...encodeEvpnNlri(t3)]);
    expect(decodeEvpnNlri(all, 0, all.length)).toEqual([t2, t2ip, t3]);
  });

  it("RD formats, prefix strings and ext-community strings match FRR", () => {
    expect(decodeRd(encodeRd("65001:100"), 0)).toBe("65001:100");
    expect(decodeRd(encodeRd("10.0.0.1:2"), 0)).toBe("10.0.0.1:2");
    expect(evpnPrefixStr(t2)).toBe("[2]:[0]:[48]:[02:00:00:00:00:10]");
    expect(evpnPrefixStr(t2ip)).toBe("[2]:[0]:[48]:[02:00:00:00:00:10]:[32]:[172.16.100.11]");
    expect(evpnPrefixStr(t3)).toBe("[3]:[0]:[32]:[10.0.0.2]");
    const local = [ecEncap(), ecRt(65001, 10100), ecMacMobility(3)];
    expect(ecListStr(local)).toBe("ET:8 RT:65001:10100 MM:3");
    expect(ecListStr(sortEcs(local))).toBe("RT:65001:10100 ET:8 MM:3");
    expect(ecRt(4200000001, 5)).toEqual([0, 2, 0xea, 0x01, 0, 0, 0, 5]); // AS & 0xFFFF (form_auto_rt)
  });

  it("encodeEvpnUpdate: MP_REACH first (0x90), no NEXT_HOP attribute; decode recovers everything", () => {
    const bytes = encodeEvpnUpdate({ reach: { nextHop: "10.0.0.2", nlri: [t3], attrs: { origin: 0, asPath: [65002], extComms: [ecEncap(), ecRt(65002, 10100)], pmsi: { flags: 0, tunnelType: 6, vni: 10100, endpoint: "10.0.0.2" } } } }, true);
    const attrStart = 19 + 2 + 2;
    expect([bytes[attrStart], bytes[attrStart + 1]]).toEqual([0x90, 14]);
    const m = decodeMessages(Uint8Array.from(bytes), true)[0] as UpdateMsg;
    expect(m.evpnReach).toEqual({ nextHop: "10.0.0.2", nlri: [t3] });
    expect(m.attrs).toMatchObject({ origin: 0, asPath: [65002], pmsi: { tunnelType: 6, vni: 10100, endpoint: "10.0.0.2" } });
    expect(m.attrs!.nextHop).toBeUndefined();
    expect(m.nlri).toEqual([]);
    const wd = decodeMessages(Uint8Array.from(encodeEvpnUpdate({ unreach: [t2] }, true)), true)[0] as UpdateMsg;
    expect(wd.evpnUnreach).toEqual([t2]);
    expect(wd.evpnReach).toBeUndefined();
  });

  it("python-tabulate grid/simple renderers (sonic-utilities tests/vxlan_test.py layouts)", () => {
    expect(tabGrid(["VLAN", "VNI"], [["Vlan100", "100"], ["Vlan101", "101"]])).toEqual([
      "+---------+-------+",
      "| VLAN    |   VNI |",
      "+=========+=======+",
      "| Vlan100 |   100 |",
      "+---------+-------+",
      "| Vlan101 |   101 |",
      "+---------+-------+",
    ]);
    expect(tabGrid(["SIP", "DIP", "Creation Source", "OperStatus"], [["1.1.1.1", "25.25.25.25", "EVPN", "oper_down"]])[1]).toBe("| SIP     | DIP         | Creation Source   | OperStatus   |");
    expect(tabSimple(["vxlan tunnel name", "source ip", "destination ip", "tunnel map name", "tunnel map mapping(vni -> vlan)"], [["vtep1", "1.1.1.1", "", "map_100_Vlan100", "100 -> Vlan100"], [" ", " ", " ", "map_101_Vlan101", "101 -> Vlan101"]])).toEqual([
      "vxlan tunnel name    source ip    destination ip    tunnel map name    tunnel map mapping(vni -> vlan)",
      "-------------------  -----------  ----------------  -----------------  ---------------------------------",
      "vtep1                1.1.1.1                        map_100_Vlan100    100 -> Vlan100",
      "                                                    map_101_Vlan101    101 -> Vlan101",
    ]);
  });
});
