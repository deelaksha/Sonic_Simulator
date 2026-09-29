/**
 * Interface-naming ("alias") — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# interface-naming standard            store "standard"
 *   sonic(config)# interface-naming standard extended   store "standard-ext"
 *   sonic(config)# no interface-naming standard          revert to "native"
 *   sonic# show interface-naming                          render from stored state
 *
 * Mirrors the real box's DEVICE_METADATA `intf_naming_mode` field in CONFIG_DB
 * (see data/device-capture/klish-xml/alias.xml — command source "alias"). The
 * `no` form writes "native" exactly as the box's del action does. We store what
 * was configured and `show interface-naming` renders it back — nothing fabricated.
 *
 * NOTE: the runtime effect of this mode — every interface being displayed with
 * standard/native names throughout the CLI — is NOT simulated; only the config
 * value is modelled.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpGet } from "../config-plane";

// configure-view: `interface-naming standard [extended]` / `no interface-naming standard`.
registerModal({
  id: "alias",
  views: ["configure-view"],
  keywords: ["interface-naming"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();
    if (sub !== "standard") return { output: [err("% interface-naming: expected `standard`")] };
    if (isNo) {
      // `no interface-naming standard` reverts DEVICE_METADATA to native mode.
      cpSet(ctx.device, "alias", "intf_naming_mode", "native");
      return { output: [] };
    }
    const extra = (args[1] ?? "").toLowerCase();
    if (extra && extra !== "extended") return { output: [err("% interface-naming: expected `extended`")] };
    cpSet(ctx.device, "alias", "intf_naming_mode", extra === "extended" ? "standard-ext" : "standard");
    return { output: [] };
  },
});

// enable-view: `show interface-naming` renders the configured naming mode.
registerModal({
  id: "alias-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "interface-naming") return null; // not ours
    const mode = (cpGet(ctx.device, "alias") ?? {}).intf_naming_mode;
    if (mode === undefined) return { output: [muted("No interface naming mode configured")] };
    return { output: [line(`Interface naming mode: ${mode}`)] };
  },
});
