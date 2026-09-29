/**
 * License management — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic# license install {home:|http:|ftp:|scp:}//<path>   record install source
 *   sonic# show license [status]                             render recorded source
 *
 * Real box: data/device-capture/klish-xml/license_mgmt.xml exposes both commands
 * in enable-view, backed by `clish_pyobj sonic_cli_license_mgmt` actions
 * (license_install / license_show). The install pulls a license file from a
 * home:/http:/ftp:/scp: URL and applies it; `show license` then reads the
 * installed license. Like the tpcm template, we follow the config-plane
 * convention of the other templates (banner/logging/ssh) and accept the write
 * command in configure-view, because the shared modal engine
 * (lib/commands/sonic-cli.ts) only routes `show` to handlers in enable-view.
 *
 * We store exactly the install source URL that was requested and reflect it on
 * `show license` — nothing about the license itself is fabricated.
 *
 * DATA-PLANE NOT SIMULATED: no license file is fetched, parsed, validated or
 * applied, and no operational license status (entitlements, features, expiry,
 * serial/host binding) is modelled or invented — only the configured install
 * source is stored and shown.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

// Matches the XML PTYPE INSTALL_FILE: home:/ ftp:/ http:/ scp:/ URLs.
const INSTALL_URL = /^(home|ftp|http|scp):\/\/.+/;

// configure-view: `license install <url>` records the install source.
registerModal({
  id: "license_mgmt",
  views: ["configure-view"],
  keywords: ["license"],
  run({ isNo, args, ctx }) {
    // `no license [install]` — clear the recorded install source.
    if (isNo) {
      cpUnset(ctx.device, "license_mgmt", "install_source");
      return { output: [] };
    }
    const sub = (args[0] ?? "").toLowerCase();
    if (sub !== "install") return { output: [err("% license: expected `install <url>`")] };
    const url = args[1];
    if (!url) return { output: [err("% license install: file URL required")] };
    if (!INSTALL_URL.test(url))
      return { output: [err("% install file must be a home://, ftp://, http:// or scp:// URL")] };
    cpSet(ctx.device, "license_mgmt", "install_source", url);
    return { output: [] };
  },
});

// enable-view: `show license [status]` renders the recorded install source.
registerModal({
  id: "license_mgmt-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "license") return null; // not ours
    const src = cpGet(ctx.device, "license_mgmt")?.install_source as string | undefined;
    if (!src) return { output: [muted("No license installed")] };
    return {
      output: [
        line(`Install source: ${src}`),
        muted("License entitlement/status is read from the installed license file (operational, not simulated in this lab)"),
      ],
    };
  },
});
