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
 * DATA-PLANE NOT SIMULATED: the operational side of `show usb` (the mounted
 * partitions table), plus `show usb devices` / `show usb partitions` and the
 * `usb mount` / `usb un-mount` actions, all reflect physically-attached storage
 * media the simulator has no hardware for. We render only the configured
 * Auto-Detection state and never fabricate detected devices/partitions.
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
    // Operational-only views: detected devices / partitions have no config to
    // reflect and depend on attached hardware — do not fabricate.
    if (sub === "devices" || sub === "partitions") {
      return { output: [muted(`USB ${sub} reflect attached storage media (operational, not simulated in this lab)`)] };
    }

    // `show usb` — render configured Auto-Detection state (the mounted-partitions
    // table is operational data and is not simulated).
    const enable = cpGet(ctx.device, "usb")?.enable;
    if (enable === undefined) return { output: [muted("USB auto-detection not configured")] };
    return {
      output: [
        line(`Auto Detection: ${enable ? "Enabled" : "Disabled"}`),
        muted("Mounted partitions reflect attached storage media (operational, not simulated in this lab)"),
      ],
    };
  },
});
