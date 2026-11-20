/**
 * USB — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# usb enable        enable usb storage auto-detection (enable=true)
 *   sonic(config)# no usb            disable usb storage auto-detection (enable=false)
 *   sonic# show usb                  render the configured Auto-Detection state
 *
 * Real box: CONFIG_DB sonic-usb USB/USB_LIST/id=GLOBAL, field `enable`
 * (true|false). See data/device-capture/klish-xml/usb.xml. `usb enable` writes
 * enable=true, `no usb` writes enable=false — a distinct "disabled" row, not a
 * deletion, so we keep the two apart from "never configured".
 *
 * The operational side (`show usb devices|partitions`, the mounted-partitions
 * table of `show usb`) renders the real templates for a box with no USB
 * storage attached (show_oc_usb_*.j2): header only / "No usb partitions mounted".
 * The `usb mount` / `usb un-mount` actions are not modelled.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpGet } from "../config-plane";

// configure-view: `usb enable` (enable=true) / `no usb` (enable=false).
registerModal({
  id: "usb",
  views: ["configure-view"],
  keywords: ["usb"],
  run({ isNo, args, ctx }) {
    // `no usb` — disable auto-detection (writes enable=false, per dbpath).
    if (isNo) {
      cpSet(ctx.device, "usb", "enable", false);
      return { output: [] };
    }
    const sub = (args[0] ?? "").toLowerCase();
    // bare `usb` — parent container command, no-op.
    if (!sub) return { output: [] };
    if (sub === "enable") {
      cpSet(ctx.device, "usb", "enable", true);
      return { output: [] };
    }
    return { output: [err("% usb: expected `enable` (or `no usb` to disable)")] };
  },
});

// enable-view: `show usb` renders the configured Auto-Detection state.
registerModal({
  id: "usb-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "usb") return null; // not ours

    const sub = args[1]?.toLowerCase();
    const dash = line("-".repeat(68));
    // show_oc_usb_devices.j2 / show_oc_usb_parts.j2: the simulated box has no USB
    // storage plugged in, so the tables carry only their header.
    if (sub === "devices") return { output: [dash, line(`${"Device name".padEnd(16)} ${"Manufacturer".padEnd(16)} Model Name`), dash] };
    if (sub === "partitions") return { output: [dash, line(`${"Device name".padEnd(16)} ${"Mount Dir".padEnd(16)} Filesystem`), dash] };

    // `show usb` — show_oc_usb_status.j2: configured Auto-Detection state, then the
    // mounted-partitions table (empty: no media attached).
    const enable = cpGet(ctx.device, "usb")?.enable;
    if (enable === undefined) return { output: [muted("USB auto-detection not configured")] };
    return {
      output: [
        line(`Auto Detection: ${enable ? "Enabled" : "Disabled"}`),
        dash,
        line(`${"Mount Dir".padEnd(16)} ${"Device Name".padEnd(16)} Filesystem`),
        dash,
        line("No usb partitions mounted"),
      ],
    };
  },
});
