/**
 * OSPFv2 modal behaviour (SUB-MODE feature, mirrors bgp.ts):
 *
 *   sonic(config)# router ospf                        -> enters the OSPF router sub-view
 *   sonic(config-router-ospf)# ospf router-id 1.1.1.1
 *   sonic(config-router-ospf)# network 10.10.3.0/24 area 1
 *   sonic(config-router-ospf)# area 0.0.0.1 stub
 *   sonic(config-router-ospf)# no network 10.10.3.0/24 area 1
 *   sonic(config-router-ospf)# no ospf router-id
 *
 * The sub-view commands delegate to the tested Click `config router ospf ...`
 * commands (lib/commands/sonic/ospf.ts) — behaviour/output are not duplicated or
 * faked. Real KLISH keyword paths are taken from
 * data/device-capture/klish-xml/ospf.xml (VIEW configure-router-ospf-view).
 */
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";

// configure-view: `router ospf` — drop into the OSPF router sub-view.
// Entry itself carries no Click effect (there is no `config router ospf` command
// without a sub-keyword; the process state is created lazily by the first
// router-id/network/area line), so we only navigate here.
registerModal({
  id: "ospf-enter",
  views: ["configure-view"],
  keywords: ["router"],
  run({ isNo, args }) {
    if (args[0]?.toLowerCase() !== "ospf") return null; // not ours (e.g. `router bgp`)
    if (isNo) return null; // `no router ospf` (unconfigure) — Click has no delete-all path
    return { output: [], enter: subViewFrame("configure-router-ospf-view") };
  },
});

// configure-router-ospf-view: `ospf router-id` / `network <cidr> area <id>` /
// `area <id> [stub|nssa]`. Everything is validated by the delegated Click module.
registerModal({
  id: "ospf",
  views: ["configure-router-ospf-view"],
  keywords: ["ospf", "network", "area"],
  run({ head, isNo, args, delegate }) {
    if (head === "ospf") {
      // Only `[no] ospf router-id` is modelled by Click (not `ospf abr-type`, …).
      if (args[0]?.toLowerCase() !== "router-id") return null;
      if (isNo) return { output: delegate("config router ospf no router-id") };
      return { output: delegate(`config router ospf router-id ${args.slice(1).join(" ")}`) };
    }
    if (head === "network") {
      // network <cidr> area <id>
      return { output: delegate(`config router ospf ${isNo ? "no " : ""}network ${args.join(" ")}`) };
    }
    if (head === "area") {
      // area <id> [stub|nssa]
      return { output: delegate(`config router ospf ${isNo ? "no " : ""}area ${args.join(" ")}`) };
    }
    return null;
  },
});
