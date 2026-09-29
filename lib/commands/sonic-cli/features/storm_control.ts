/**
 * Storm-control (BUM rate limiting) — CONFIG-PLANE feature. There is no Click
 * module and no packet/engine backend, so we STORE exactly what is configured
 * (per interface, per storm-type, in kbps) and RENDER it back on `show`, the way
 * the real box keeps it in CONFIG_DB (PORT_STORM_CONTROL). Nothing is fabricated;
 * no operational counters or drop stats are invented.
 *
 * Wired from data/device-capture/klish-xml/storm_control.xml:
 *
 * configure-if-view (per physical interface):
 *   storm-control broadcast <kbps>            store broadcast rate
 *   storm-control unknown-unicast <kbps>      store unknown-unicast rate
 *   storm-control unknown-multicast <kbps>    store unknown-multicast rate
 *   no storm-control <type>                   clear that type on the interface
 *   no storm-control                          clear all types on the interface
 *
 * enable-view:
 *   show storm-control                        render all stored entries
 *   show storm-control interface Ethernet <n> render entries for one interface
 *
 * NOTE: the rate limit is stored and shown but NOT enforced on simulated traffic
 * (no data-plane) — dataPlaneNotSimulated.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";

const TYPES = ["broadcast", "unknown-unicast", "unknown-multicast"];

interface StormEntry {
  id: string; // "<iface>|<type>" — de-dup key
  iface: string;
  type: string;
  kbps: string;
}

registerModal({
  id: "storm_control",
  views: ["configure-if-view"],
  keywords: ["storm-control"],
  run({ isNo, args, ifname, ctx }) {
    const iface = ifname ?? "";
    const type = (args[0] ?? "").toLowerCase();

    if (isNo) {
      // Bare `no storm-control` clears every storm-type on this interface.
      if (!type) {
        for (const t of TYPES) cpRemove(ctx.device, "storm_control", "ports", "id", `${iface}|${t}`);
        return { output: [] };
      }
      if (!TYPES.includes(type)) return { output: [err(`% storm-type must be one of ${TYPES.join("|")}`)] };
      cpRemove(ctx.device, "storm_control", "ports", "id", `${iface}|${type}`);
      return { output: [] };
    }

    if (!TYPES.includes(type)) return { output: [err(`% storm-type must be one of ${TYPES.join("|")}`)] };
    const kbps = args[1];
    if (!kbps || !/^\d+$/.test(kbps)) return { output: [err("% Usage: storm-control <type> <kbps>")] };
    cpUpsert(ctx.device, "storm_control", "ports", { id: `${iface}|${type}`, iface, type, kbps }, "id");
    return { output: [] };
  },
});

registerModal({
  id: "storm_control-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "storm-control") return null; // not ours

    let entries = cpList(ctx.device, "storm_control", "ports") as unknown as StormEntry[];

    // `show storm-control interface Ethernet <n>` — filter to one interface.
    if (args[1]?.toLowerCase() === "interface") {
      const want = args.slice(2).join("").toLowerCase();
      entries = entries.filter((e) => e.iface.toLowerCase() === want);
    }

    const out = [
      muted("-".repeat(53)),
      line(`${"Interface Name".padEnd(20)}${"Storm-type".padEnd(20)}Rate (kbps)`),
      muted("-".repeat(53)),
      ...entries.map((e) => line(`${e.iface.padEnd(20)}${e.type.padEnd(20)}${e.kbps}`)),
    ];
    return { output: out };
  },
});
