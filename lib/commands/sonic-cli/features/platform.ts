/**
 * Platform modal behaviour.
 *
 * The `platform` feature is SHOW-ONLY: every KLISH command lives in `enable-view`
 * (`show platform summary|syseeprom|psustatus|fanstatus|temperature|firmware|
 * ssdhealth|i2c ...` and `clear i2c ...` — see data/device-capture/klish-xml/
 * platform.xml). There are NO `platform` commands in configure-view,
 * configure-if-view, configure-vlan-view or configure-lag-view, and the Click
 * module (lib/commands/sonic/platform.ts) exports an empty `config` array. The
 * `config platform ...` node in click-config-tree.txt is only a root-privilege
 * stub with no cloned subcommands.
 *
 * Show commands are already delegated to the tested Click layer by the core
 * engine (runSonicCli routes `show ...` through execute()), so nothing needs to
 * be wired here. This handler therefore claims the `platform` keyword in
 * configure-view and always returns null, letting the grammar-aware fallback
 * report any `platform` config attempt as unrecognized rather than faking it.
 */
import { registerModal } from "../registry";

registerModal({
  id: "platform",
  views: ["configure-view"],
  keywords: ["platform"],
  // No configure-view platform config exists in this feature: decline everything.
  run() {
    return null;
  },
});
