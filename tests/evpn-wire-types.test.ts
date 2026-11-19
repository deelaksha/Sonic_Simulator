import { describe, it, expect } from "vitest";
import { decodeEvpnNlri, encodeEvpnNlri, evpnPrefixStr, EvpnRoute, ecDfElection, ecDfOf, ecEncap, ecEsImportRt, ecEsiLabel, ecListStr, ecRouterMac, ecRouterMacOf, ecRt, sortEcs } from "../lib/protocols/evpn-wire";

describe("EVPN route types 1/4/5 and two-label type-2 (bgp_evpn_encode_prefix, evpn_mpattr_encode_type5)", () => {
  const esi = "00:11:22:33:44:55:00:00:00:01";
  const t2 = { type: 2, rd: "10.0.0.1:2", ethTag: 0, mac: "02:00:00:00:00:15", ip: "10.1.0.11", vni: 10010, vni2: 50000 } as EvpnRoute;
  const t1 = { type: 1, rd: "10.0.0.1:5", esi, ethTag: 0xffffffff, vni: 0 } as EvpnRoute;
  const t4 = { type: 4, rd: "10.0.0.1:5", esi, ethTag: 0, origIp: "10.0.0.1" } as EvpnRoute;
  const t5 = { type: 5, rd: "10.0.0.2:3", ethTag: 0, ipLen: 24, ip: "10.2.0.0", vni: 50000 } as EvpnRoute;

  it("lengths: type-2 MAC+IP with L3 VNI 40, type-1 25, type-4 23, type-5 34; all round-trip", () => {
    expect(encodeEvpnNlri(t2).slice(0, 2)).toEqual([2, 40]);
    expect(encodeEvpnNlri(t2).slice(-6)).toEqual([0x00, 0x27, 0x1a, 0x00, 0xc3, 0x50]); // label1 10010, label2 50000
    expect(encodeEvpnNlri(t1).slice(0, 2)).toEqual([1, 25]);
    expect(encodeEvpnNlri(t4).slice(0, 2)).toEqual([4, 23]);
    expect(encodeEvpnNlri(t5).slice(0, 2)).toEqual([5, 34]);
    const all = Uint8Array.from([t2, t1, t4, t5].flatMap(encodeEvpnNlri));
    expect(decodeEvpnNlri(all, 0, all.length)).toEqual([t2, t1, t4, t5]);
  });

  it("prefix strings (lib/prefix.c ead2str / es2str / prefix2str)", () => {
    expect(evpnPrefixStr(t1)).toBe(`[1]:[4294967295]:[${esi}]:[32]:[0.0.0.0]:[0]`);
    expect(evpnPrefixStr(t4)).toBe(`[4]:[${esi}]:[32]:[10.0.0.1]`);
    expect(evpnPrefixStr(t5)).toBe("[5]:[0]:[24]:[10.2.0.0]");
  });

  it("extended communities: Rmac, ESI label, ES-Import RT, DF election (bgp_ecommunity.c strings)", () => {
    const ecs = [ecEncap(), ecRt(65001, 10010), ecRt(65001, 50000), ecRouterMac("02:00:00:3c:fe:bd")];
    expect(ecListStr(ecs)).toBe("ET:8 RT:65001:10010 RT:65001:50000 Rmac:02:00:00:3c:fe:bd");
    expect(ecListStr(sortEcs(ecs))).toBe("RT:65001:10010 RT:65001:50000 ET:8 Rmac:02:00:00:3c:fe:bd");
    expect(ecRouterMacOf(ecs)).toBe("02:00:00:3c:fe:bd");
    expect(ecListStr([ecEsiLabel(), ecEsImportRt(esi), ecDfElection(32767)])).toBe("ESI-label-Rt:AA ES-Import-Rt:11:22:33:44:55:00 DF: (alg: 2, pref: 32767)");
    expect(ecDfOf([ecDfElection(50000)])).toEqual({ alg: 2, pref: 50000 });
  });
});
