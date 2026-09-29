/**
 * Event / Alarm — CONFIG-PLANE feature (no engine backend; show-only).
 *
 *   sonic# show event [details|id <id>|recent <interval>|severity <sev>|summary]
 *   sonic# show alarm [all|acknowledged|detail|id <id>|recent <interval>|severity <sev>|summary]
 *
 * Per data/device-capture/klish-xml/event.xml every `event`/`alarm` command lives
 * in enable-view and is purely OPERATIONAL: `show event` / `show alarm` render the
 * box's live event & alarm records (from the eventd / EVENT_DB runtime tables) and
 * `alarm acknowledge|unacknowledge <id>` mutate a live active alarm. There is NO
 * CONFIG_DB configuration for this feature — nothing is written on `configure`.
 *
 * This simulator has no eventd runtime, so there are no events or alarms to model.
 * Honouring the rule "never fabricate runtime data", we do NOT invent event/alarm
 * rows, severities, timestamps or counts. The `show` handler renders exactly what
 * is stored in the config-plane (always empty for this feature) and otherwise
 * reports honestly that the event/alarm history is runtime data not simulated.
 * (`alarm acknowledge|unacknowledge` act on that same non-simulated runtime state
 * and are not modelled; they are also not routable to a modal handler without
 * editing the shared dispatcher.)
 */
import { OutputLine, line, muted } from "../../types";
import { registerModal } from "../registry";
import { cpList } from "../config-plane";

const NOT_SIMULATED = "event/alarm history is runtime data not simulated in this lab";

/** Render the stored (config-plane) records for a kind; empty for this feature. */
function render(rows: Record<string, unknown>[], kind: "event" | "alarm"): OutputLine[] {
  if (!rows.length) return [muted(`% No ${kind}s to display — ${NOT_SIMULATED}`)];
  return rows.map((r) => line(String(r.id ?? r.description ?? JSON.stringify(r))));
}

// enable-view: `show event ...` / `show alarm ...` (routed here as head "show").
registerModal({
  id: "event-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const what = args[0]?.toLowerCase();
    if (what !== "event" && what !== "alarm") return null; // not ours
    // Config-plane store is empty (no config command populates it); reflect only
    // what is stored — never fabricate runtime event/alarm rows.
    const rows = cpList(ctx.device, "event", what === "event" ? "events" : "alarms");
    return { output: render(rows, what) };
  },
});
