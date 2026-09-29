/**
 * key (config-key password-encrypt) — CONFIG-PLANE primary encryption key.
 *
 *   sonic(config)# key config-key password-encrypt <passphrase>   store user key
 *   sonic(config)# no key config-key password-encrypt [override]  fall back to default
 *   sonic# show config-key password-encrypt                       render configured state
 *
 * On the real box the passphrase is entered interactively (New key/Old key) and
 * is never echoed. CONFIG_DB only records whether a user-configured key is in
 * use (PRIMARY_ENCRYPTION_KEY_TABLE, id=config, configured=true/false) and
 * `show config-key password-encrypt` reports just that boolean. We store the
 * configured passphrase + flag and render only the boolean, exactly like the
 * device. The runtime crypto (deriving/re-encrypting protocol passwords with
 * the key) is NOT simulated — only the config state is modelled.
 */
import { line, err } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

// PRIMARY_ENCRYPTION_KEY ptype: ASCII printable except SPACE, '#', ','; max 65.
const KEY_RE = /^[^ #,]{1,65}$/;

registerModal({
  id: "key",
  views: ["configure-view"],
  keywords: ["key"],
  run({ isNo, args, ctx }) {
    // Only claim "key config-key password-encrypt ..."; leave bare "key" /
    // "key config-key" to the grammar fallback.
    if ((args[0] ?? "").toLowerCase() !== "config-key") return null;
    if ((args[1] ?? "").toLowerCase() !== "password-encrypt") return null;

    if (isNo) {
      // Revert to the device-specific default key.
      cpUnset(ctx.device, "key", "passphrase");
      cpSet(ctx.device, "key", "configured", false);
      return { output: [line("Primary encryption key updated successfully.")] };
    }

    const passphrase = args[2] ?? "";
    if (!passphrase) return { output: [err("% New key required")] };
    if (!KEY_RE.test(passphrase)) {
      return { output: [err("% key: max 65 ASCII printable chars, excluding space, '#' and ','")] };
    }
    cpSet(ctx.device, "key", "passphrase", passphrase);
    cpSet(ctx.device, "key", "configured", true);
    return { output: [line("Primary encryption key updated successfully.")] };
  },
});

registerModal({
  id: "key-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "config-key") return null; // not ours
    const configured = cpGet(ctx.device, "key")?.configured === true;
    return { output: [line(`Primary encryption key configured : ${configured ? "True" : "False"}`)] };
  },
});
