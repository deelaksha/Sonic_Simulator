/**
 * Locator LED — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# locator-led chassis on [timer <0-120>]   store chassis LED = on
 *   sonic(config)# locator-led chassis off                  store chassis LED = off
 *   sonic(config)# no locator-led chassis                   clear stored state
 *   sonic# show locator-led [chassis]                       render from stored state
 *
 * Mirrors the real box's chassis Locator LED utility (see
 * data/device-capture/klish-xml/locator_led.xml). On the box these are
 * enable-view `locator-led chassis on|off` operational commands driving the
 * `sonic_cli_locator_led` platform action; here we honestly store the requested
 * state (on/off + optional auto-off timer) and render it back on `show`. Nothing
 * is fabricated — if no locator-led command has been run, `show` reports that no
 * state is configured rather than inventing a physical LED value.
 *
 * DATA-PLANE NOT SIMULATED: the actual chassis LED illumination and the auto-off
 * timer expiry are physical/hardware effects the simulator cannot model — only
 * the requested config is stored and shown.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

const ID = "locator_led";

// configure-view: `locator-led chassis on|off [timer <n>]` / `no locator-led chassis`.
registerModal({
  id: "locator-led",
  views: ["configure-view"],
  keywords: ["locator-led"],
  run({ isNo, args, ctx }) {
    const target = (args[0] ?? "").toLowerCase();
    if (target !== "chassis") return { output: [err("% locator-led: expected `chassis`")] };

    if (isNo) {
      cpUnset(ctx.device, ID, "chassis");
      cpUnset(ctx.device, ID, "chassis_timer");
      return { output: [] };
    }

    const op = (args[1] ?? "").toLowerCase();
    if (op === "off") {
      cpSet(ctx.device, ID, "chassis", "off");
      cpUnset(ctx.device, ID, "chassis_timer");
      return { output: [] };
    }
    if (op === "on") {
      let timer = 0;
      if (args[2] !== undefined) {
        if ((args[2] ?? "").toLowerCase() !== "timer")
          return { output: [err("% locator-led chassis on: expected `timer <0-120>`")] };
        const n = Number(args[3]);
        if (args[3] === undefined || !Number.isInteger(n) || n < 0 || n > 120)
          return { output: [err("% timer value must be an integer 0-120 (minutes)")] };
        timer = n;
      }
      cpSet(ctx.device, ID, "chassis", "on");
      cpSet(ctx.device, ID, "chassis_timer", timer);
      return { output: [] };
    }
    return { output: [err("% locator-led chassis: expected `on` or `off`")] };
  },
});

// enable-view: `show locator-led [chassis]` renders the stored chassis LED state.
registerModal({
  id: "locator-led-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "locator-led") return null; // not ours
    const st = cpGet(ctx.device, ID) ?? {};
    const state = st.chassis;
    if (state === undefined) return { output: [muted("No locator LED state configured")] };

    const on = String(state).toLowerCase() === "on";
    const timer = Number(st.chassis_timer ?? 0);
    let value = on ? "On" : "Off";
    if (on && timer > 0) value += ` (auto-off timer: ${timer} min)`;
    const out: OutputLine[] = [line(`Chassis Locator LED : ${value}`)];
    return { output: out };
  },
});
