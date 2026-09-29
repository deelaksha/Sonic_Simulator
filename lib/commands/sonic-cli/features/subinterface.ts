/**
 * Subinterface — CONFIG-PLANE feature (no Click module, no engine/packet backend;
 * store + show). Models the real box's VLAN_SUB_INTERFACE CONFIG_DB table.
 *
 *   sonic(conf-subif-Ethernet0.10)# encapsulation dot1q vlan-id 100
 *   sonic(conf-subif-Ethernet0.10)# mtu 2000
 *   sonic(conf-subif-Ethernet0.10)# description "Link to R1"
 *   sonic(conf-subif-Ethernet0.10)# shutdown | no shutdown
 *   sonic(conf-subif-Ethernet0.10)# no encapsulation | no mtu | no description
 *   sonic# show subinterfaces [status]                render the status table
 *   sonic# show running-configuration subinterface [<name>]   render the config dump
 *
 * Wired from data/device-capture/klish-xml/subinterface.xml. Each subinterface is
 * stored honestly (keyed by its dotted name) and `show` renders exactly what was
 * configured — nothing is fabricated.
 *
 * DATA-PLANE NOT SIMULATED: a routed subinterface is a packet-forwarding construct
 * (it routes 802.1Q-tagged traffic). The sim does not forward, so operational
 * columns (Speed, oper-state) are shown as "-", never invented.
 *
 * SIM LIMITATION: the sub-view (configure-subif-view) is only reachable on the real
 * box via `interface Ethernet 0.10`; the shared core `interface` handler rejects
 * dotted names, so — like the other subif-view features (sag / dhcpv6_relay /
 * link_track) — these handlers serve the sub-view once it is on the stack. They are
 * dispatched through genericView using the frame built by subViewFrame().
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpList } from "../config-plane";
import { Device } from "../../../models/device";

const ID = "subinterface";
const KEY = "subifs";

interface Subif {
  name: string; // dotted subinterface name, e.g. "Ethernet0.10"
  vlan?: number; // encapsulation dot1q vlan-id
  mtu?: number;
  description?: string;
  admin?: "up" | "down"; // no shutdown / shutdown
}

type OptField = Exclude<keyof Subif, "name">;

function setField(device: Device, name: string, field: OptField, value: unknown): void {
  const item: Record<string, unknown> = { name };
  item[field] = value;
  cpUpsert(device, ID, KEY, item, "name");
}
function clearField(device: Device, name: string, field: OptField): void {
  const item = (cpList(device, ID, KEY) as unknown as Subif[]).find((s) => s.name === name);
  if (item) delete item[field];
}

// configure-subif-view: the subinterface's own config commands. The dotted
// subinterface name is carried in the sub-view context (a.viewctx).
registerModal({
  id: "subinterface",
  views: ["configure-subif-view"],
  keywords: ["encapsulation", "mtu", "description", "shutdown"],
  run({ head, isNo, args, viewctx, ctx }) {
    const name = viewctx ?? "";
    if (!name) return { output: [err("% subinterface context required")] };

    if (head === "encapsulation") {
      if (isNo) {
        clearField(ctx.device, name, "vlan");
        return { output: [] };
      }
      if ((args[0] ?? "").toLowerCase() !== "dot1q" || (args[1] ?? "").toLowerCase() !== "vlan-id")
        return { output: [err("% Usage: encapsulation dot1q vlan-id <1-4094>")] };
      const id = Number(args[2]);
      if (!Number.isInteger(id) || id < 1 || id > 4094) return { output: [err("% VLAN ID must be 1-4094")] };
      setField(ctx.device, name, "vlan", id);
      return { output: [] };
    }

    if (head === "mtu") {
      if (isNo) {
        clearField(ctx.device, name, "mtu");
        return { output: [] };
      }
      const m = Number(args[0]);
      if (!Number.isInteger(m) || m < 1 || m > 9216) return { output: [err("% MTU must be 1-9216")] };
      setField(ctx.device, name, "mtu", m);
      return { output: [] };
    }

    if (head === "description") {
      if (isNo) {
        clearField(ctx.device, name, "description");
        return { output: [] };
      }
      const text = args.join(" ").replace(/^"|"$/g, "");
      if (!text) return { output: [err("% description text required")] };
      setField(ctx.device, name, "description", text);
      return { output: [] };
    }

    if (head === "shutdown") {
      setField(ctx.device, name, "admin", isNo ? "up" : "down");
      return { output: [] };
    }

    return null; // not ours
  },
});

// enable-view: `show subinterfaces [status]` and `show running-configuration subinterface [<name>]`.
registerModal({
  id: "subinterface-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a0 = (args[0] ?? "").toLowerCase();
    const a1 = (args[1] ?? "").toLowerCase();
    if (a0 !== "subinterfaces" && !(a0 === "running-configuration" && a1 === "subinterface")) return null; // not ours
    const subifs = cpList(ctx.device, ID, KEY) as unknown as Subif[];

    if (a0 === "running-configuration") {
      const filter = args.slice(2).join("").replace(/\s+/g, "");
      const list = filter ? subifs.filter((s) => s.name.replace(/\s+/g, "") === filter) : subifs;
      if (!list.length) return { output: [muted("No subinterfaces configured")] };
      const out: OutputLine[] = [line("!")];
      for (const s of list) {
        out.push(line(`interface ${s.name}`));
        if (s.vlan !== undefined) out.push(line(` encapsulation dot1q vlan-id ${s.vlan}`));
        if (s.mtu !== undefined) out.push(line(` mtu ${s.mtu}`));
        if (s.description !== undefined) out.push(line(` description ${s.description}`));
        if (s.admin !== undefined) out.push(line(` ${s.admin === "down" ? "shutdown" : "no shutdown"}`));
        out.push(line("!"));
      }
      return { output: out };
    }

    // show subinterfaces [status]
    if (!subifs.length) return { output: [muted("No subinterfaces configured")] };
    const cell = (v: unknown) => (v === undefined || v === "" ? "-" : String(v));
    const row = (i: string, sp: string, m: string, v: string, ad: string, t: string) =>
      i.padEnd(21) + sp.padEnd(10) + m.padEnd(10) + v.padEnd(10) + ad.padEnd(10) + t;
    const dash = "-".repeat(95);
    const out: OutputLine[] = [
      line(dash),
      line(row("Sub port interface", "Speed", "MTU", "Vlan", "Admin", "Type")),
      line(dash),
    ];
    for (const s of subifs) {
      out.push(
        line(
          row(
            cell(s.name),
            "-", // Speed is operational — not simulated
            cell(s.mtu),
            cell(s.vlan),
            cell(s.admin),
            s.vlan !== undefined ? "dot1q-encapsulation" : "-",
          ),
        ),
      );
    }
    return { output: out };
  },
});
