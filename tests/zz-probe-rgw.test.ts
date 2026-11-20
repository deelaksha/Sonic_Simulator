import { it, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, out } from "./control-helpers";
const dev = (id: string) => S().network.devices[id];
const port = (id: string, n: number) => dev(id).interfaces.filter((i) => !i.management)[n];
it("probe", () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); resetAll();
  // PC - R1 - R2 - PC2 ; R1 default gw -> R2, R2 default gw -> R1
  const r1 = S().addDevice("router", { x: 0, y: 0 });
  const r2 = S().addDevice("router", { x: 0, y: 0 });
  S().setInterfaceIp(r1, port(r1,1).id, "10.0.0.1", 30);
  S().setInterfaceIp(r2, port(r2,1).id, "10.0.0.2", 30);
  S().connect(r1, port(r1,1).id, r2, port(r2,1).id);
  const a = S().addDevice("pc", { x: 0, y: 0 }); S().connect(a, port(a,0).id, r1, port(r1,0).id, { autoDhcp: true });
  const b = S().addDevice("pc", { x: 0, y: 0 }); S().connect(b, port(b,0).id, r2, port(r2,0).id, { autoDhcp: true });
  const bip = port(b,0).ipv4[0].address;
  console.log("BEFORE", out(S().execCommand(a, `ping -c 1 ${bip}`)).split("\n").filter(l=>/loss|nreach/.test(l)).join());
  S().setDefaultGateway(r1, "10.0.0.2");
  S().setDefaultGateway(r2, "10.0.0.1");
  console.log("UI-GW", out(S().execCommand(a, `ping -c 1 ${bip}`)).split("\n").filter(l=>/loss|nreach/.test(l)).join());
  console.log("R1 ROUTE", out(S().execCommand(r1, "ip route")));
  S().setDefaultGateway(r1, undefined); S().setDefaultGateway(r2, undefined);
  console.log("CLI1", out(S().execCommand(r1, "ip route add default via 10.0.0.2")));
  console.log("CLI2", out(S().execCommand(r2, "ip route add default via 10.0.0.1")));
  console.log("CLI-GW", out(S().execCommand(a, `ping -c 1 ${bip}`)).split("\n").filter(l=>/loss|nreach/.test(l)).join());
  console.log("R1 ROUTE2", out(S().execCommand(r1, "ip route")), "cfg gw", dev(r1).config.defaultGateway);
  console.log("BADGW", JSON.stringify((()=>{try{S().setDefaultGateway(r1,"99.9.9.9");return out(S().execCommand(r1,"ip route"))}catch(e){return String(e)}})()));
});
