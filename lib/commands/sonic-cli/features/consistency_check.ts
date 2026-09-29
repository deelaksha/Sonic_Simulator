/**
 * Consistency-check — OPERATIONAL verification feature (no CONFIG_DB config).
 *
 *   sonic# consistency-check start [access-list [mac|ipv4|ipv6 [name]]
 *                                 | route [vrf <v> [address-family <af>]]]
 *   sonic# consistency-check stop  [access-list|route]
 *   sonic# show consistency-check
 *   sonic# show consistency-check status [access-list [brief|detail] [errors] | route]
 *
 * On the real box (data/device-capture/klish-xml/consistency_check.xml) every one
 * of these lives in enable-view and is an on-demand RPC ACTION, not a CONFIG_DB
 * write: `start`/`stop` trigger/cancel a background checker that compares
 * CONFIG_DB against the ASIC/APPL state, and `show consistency-check status`
 * reports which ACL/route entries matched or have errors.
 *
 * Two facts make this a SHOW-ONLY config-plane feature:
 *  - There is NOTHING to store: the feature has no CONFIG_DB state, so there are
 *    no cp* writes here (nothing would ever be read back).
 *  - The `start`/`stop` action commands are enable-view, and the shared sonic-cli
 *    core only routes enable-view `show` through modal handlers; cloning those
 *    actions would mean editing a shared file, so they are intentionally not
 *    handled here. This handler covers the `show` side only.
 *
 * dataPlaneNotSimulated: the simulator never runs the consistency checker, so the
 * per-entry verification RESULTS (matches/errors) are runtime data we do NOT
 * fabricate — `show` honestly reports that no results are available.
 */
import { OutputLine, muted } from "../../types";
import { registerModal } from "../registry";

// enable-view: `show consistency-check [status [access-list [brief|detail] [errors] | route]]`.
// Nothing is stored for this feature, so nothing configured is rendered; the
// verification results themselves are operational and are not fabricated.
registerModal({
  id: "consistency-check-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args }) {
    if (args[0]?.toLowerCase() !== "consistency-check") return null; // not ours

    const out: OutputLine[] = [];
    if (args[1]?.toLowerCase() === "status") {
      const feat = args[2]?.toLowerCase();
      const scope = feat === "access-list" || feat === "route" ? feat : "all";
      out.push(muted(`Consistency-check status (${scope}): no results.`));
      out.push(
        muted(
          "The checker runs on demand (`consistency-check start`) and compares " +
            "CONFIG_DB against ASIC/APPL state; it is not run in this simulator, so " +
            "no verified entries or errors are reported.",
        ),
      );
    } else {
      out.push(muted("Consistency-check: on-demand verification (start/stop); not run in this simulator."));
    }
    return { output: out };
  },
});
