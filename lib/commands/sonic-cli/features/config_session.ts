/**
 * Config session — CONFIG-PLANE feature (no engine backend; show-only clone).
 *
 *   sonic# configure session                     (core enters config mode)
 *   sonic(config-s)# abort                        discard the session
 *   sonic# show config                            session/checkpoint summary
 *   sonic# show config session [details]          session state table / detail
 *   sonic# show config session diff               running vs candidate diff
 *   sonic# show config checkpoints [brief|details|<label> details]
 *   sonic(config-s)# show session-config [diff]   candidate/running unified/diff
 *
 * See data/device-capture/klish-xml/config_session.xml. Unlike banner/logging,
 * config sessions have NO persistent CONFIG_DB table — everything (session
 * state, age, checkpoints, candidate-vs-running diffs) is runtime state cached
 * in the management REST server. This simulator applies configuration LIVE (see
 * the core `commit` handling in lib/commands/sonic-cli.ts), so there is never a
 * candidate session, no checkpoints and no diff. We therefore do NOT fabricate
 * any session/checkpoint/diff runtime data: the `show` handlers render the real
 * box's column headers with an honest "nothing in progress" note, and `abort`
 * reports that there is no session to discard. There is nothing to cp*-store.
 * The session data-plane (candidate cache, commit/abort lifecycle, checkpoints)
 * is NOT simulated.
 *
 * NOTE: `commit`/`clear config session` are handled by the core (commit is
 * applied live) and by grammar fallback respectively, so they are not owned here.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";

const SESSION_HDR = "Name".padEnd(20) + "State".padEnd(10) + "Age".padEnd(11) + "User";
const SESSION_DASH = "-".repeat(19).padEnd(20) + "-".repeat(9).padEnd(10) + "-".repeat(10).padEnd(11) + "-".repeat(10);
const CKPT_HDR = "ID".padEnd(14) + "Timestamp".padEnd(26) + "Label";
const CKPT_DASH = "-".repeat(12).padEnd(14) + "-".repeat(24).padEnd(26) + "-".repeat(21);

const LIVE_NOTE = "(this simulator applies configuration live; config sessions are not modelled)";

function sessionTable(): OutputLine[] {
  return [line(SESSION_HDR), line(SESSION_DASH), muted(`No configuration session in progress ${LIVE_NOTE}`)];
}

// configure-view: `abort` — discard the current config session.
registerModal({
  id: "config-session",
  views: ["configure-view"],
  keywords: ["abort"],
  run() {
    return { output: [muted(`% No configuration session in progress to abort ${LIVE_NOTE}`)] };
  },
});

// enable-view: `show config*` and (in-session) `show session-config*`. Every
// `show` is routed here by the core; return null for anything not ours.
registerModal({
  id: "config-session-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args }) {
    const head = args[0]?.toLowerCase();

    // In-session: `show session-config [diff]`.
    if (head === "session-config") {
      if (args[1]?.toLowerCase() === "diff") {
        return { output: [muted(`No differences between running-config and session config ${LIVE_NOTE}`)] };
      }
      return { output: [muted(`No cached session configuration ${LIVE_NOTE}`)] };
    }

    if (head !== "config") return null; // not ours (e.g. `show config-reload`, `show config-key`)

    const sub = args[1]?.toLowerCase();

    // `show config` — brief session + checkpoint summary.
    if (sub === undefined) {
      return { output: [muted(`No configuration session in progress; no checkpoints ${LIVE_NOTE}`)] };
    }

    if (sub === "session") {
      if (args[2]?.toLowerCase() === "diff") {
        return { output: [muted(`No differences between running-config and session config ${LIVE_NOTE}`)] };
      }
      // brief table or `details` — no session either way.
      return { output: sessionTable() };
    }

    if (sub === "checkpoints") {
      return { output: [line(CKPT_HDR), line(CKPT_DASH), muted(`No configuration checkpoints ${LIVE_NOTE}`)] };
    }

    return { output: [err(`% Unknown "show config" option "${args[1]}"`)] };
  },
});
