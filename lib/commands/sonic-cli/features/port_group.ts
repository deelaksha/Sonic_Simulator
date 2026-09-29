/**
 * Port-group — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# port-group <id> speed <mbps>   store the speed for a port-group
 *   sonic(config)# no port-group <id> speed       revert to platform default (clear)
 *   sonic# show port-group                        render configured port-groups
 *
 * Real box (data/device-capture/klish-xml/port_group.xml): CONFIG_DB
 * PORT_GROUP|PORT_GROUP_LIST with fields { id, speed }. We store exactly the
 * per-port-group speed that is configured and render it back on `show port-group`.
 *
 * NOTE (dataPlaneNotSimulated): a port-group's "Interface range" and "Valid
 * speeds" are platform/hardware-derived state (the port-group feature "is not
 * supported in all the hardware platforms"). The sim does not model that
 * hardware, so those columns are shown as "-" rather than fabricated; only the
 * configured speed is reflected. The runtime effect (member ports actually
 * re-speeding) is likewise not simulated.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";

// INTF_SPEED ptype (sonic_types.xml): accepted port speeds in Mbps.
const SPEEDS = ["10", "100", "1000", "2500", "5000", "10000", "20000", "25000", "40000", "50000", "100000", "200000", "400000", "800000"];

interface PortGroup {
  id: string;
  speed: string;
}

// PORT_GROUP entity (sonic_types.xml): id is 1..99.
const validId = (id: string): boolean => /^([1-9]|[1-9][0-9])$/.test(id);

// configure-view: `port-group <id> speed <mbps>` and `no port-group <id> speed`.
registerModal({
  id: "port_group",
  views: ["configure-view"],
  keywords: ["port-group"],
  run({ isNo, args, ctx }) {
    const pg = args[0] ?? "";
    if (!validId(pg)) return { output: [err("% port-group id must be 1-99")] };
    if ((args[1] ?? "").toLowerCase() !== "speed") return { output: [err("% expected `port-group <id> speed <mbps>`")] };
    if (isNo) {
      cpRemove(ctx.device, "port_group", "groups", "id", pg);
      return { output: [] };
    }
    const speed = args[2];
    if (!speed) return { output: [err("% port speed required")] };
    if (!SPEEDS.includes(speed)) return { output: [err(`% port speed must be one of ${SPEEDS.join("|")}`)] };
    cpUpsert(ctx.device, "port_group", "groups", { id: pg, speed }, "id");
    return { output: [] };
  },
});

// enable-view: `show port-group` renders the configured port-groups.
registerModal({
  id: "port_group-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "port-group") return null; // not ours
    const groups = cpList(ctx.device, "port_group", "groups") as unknown as PortGroup[];
    if (!groups.length) return { output: [muted("No port-groups configured")] };
    const dash = "-".repeat(71);
    const row = (pg: string, range: string, valid: string, speed: string) =>
      pg.padEnd(12) + range.padEnd(27) + valid.padEnd(18) + speed;
    // "Interface range" / "Valid speeds" are platform data the sim does not model -> "-".
    const out = [line(dash), line(row("Port-group", "Interface range", "Valid speeds", "Default Speed")), line(dash)];
    const sorted = [...groups].sort((a, b) => Number(a.id) - Number(b.id));
    for (const g of sorted) out.push(line(row(g.id, "-", "-", g.speed)));
    return { output: out };
  },
});
