/**
 * BFD modal behaviour (feature SUB-MODE cloning, two nested views).
 *
 *   sonic(config)# bfd                         -> enters BFD sub-view (no effect)
 *   sonic(config-bfd)# peer 10.10.10.1 interface Ethernet0
 *                                              -> config bfd peer add ... + enters peer sub-view
 *   sonic(config-bfd-peer)# detect-multiplier 5
 *   sonic(config-bfd-peer)# receive-interval 200
 *   sonic(config-bfd-peer)# transmit-interval 200
 *   sonic(config-bfd-peer)# shutdown | no shutdown
 *   sonic(config-bfd)# no peer 10.10.10.1      -> config bfd peer del (stays in BFD view)
 *
 * The tested Click module (lib/commands/sonic/bfd.ts) is FLAT: every sub-command
 * carries the peer IP as an argument. In the modal peer sub-view that IP is the
 * view context (a.viewctx, set on entry), so each in-mode command delegates to
 * `config bfd peer <cmd> <viewctx-ip> ...`. Behaviour/output is not re-faked.
 */
import { err } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";

// configure-view: `bfd` enters the BFD sub-view (clish_nop in KLISH -> no effect).
registerModal({
  id: "bfd-enter",
  views: ["configure-view"],
  keywords: ["bfd"],
  run({ isNo }) {
    if (isNo) return null; // `no bfd` is not a real command; fall through.
    return { output: [], enter: subViewFrame("configure-bfd-view") };
  },
});

// configure-bfd-view: `peer <ip> ...` adds the peer + enters the peer sub-view;
// `no peer <ip>` deletes it and stays. Delegates to `config bfd peer add|del`.
registerModal({
  id: "bfd",
  views: ["configure-bfd-view"],
  keywords: ["peer"],
  run({ isNo, args, delegate }) {
    const ip = args[0];
    if (!ip) return { output: [err("% BFD peer IP address required.")] };
    if (isNo) return { output: delegate(`config bfd peer del ${ip}`) };
    // Forward the identity tokens verbatim (interface/local-address/multihop
    // share the exact keyword names the Click parser expects).
    return {
      output: delegate(`config bfd peer add ${args.join(" ")}`),
      enter: subViewFrame("configure-bfd-peer-view", ip),
    };
  },
});

// configure-bfd-peer-view: per-peer timers/admin state. The peer IP is a.viewctx.
registerModal({
  id: "bfd-peer",
  views: ["configure-bfd-peer-view"],
  keywords: ["detect-multiplier", "receive-interval", "transmit-interval", "shutdown"],
  run({ head, isNo, args, viewctx, delegate }) {
    const ip = viewctx ?? "";
    if (head === "shutdown") {
      return { output: delegate(`config bfd peer ${isNo ? "no-shutdown" : "shutdown"} ${ip}`) };
    }
    // detect-multiplier / receive-interval / transmit-interval: no reset form in Click.
    if (isNo) return null;
    return { output: delegate(`config bfd peer ${head} ${ip} ${args.join(" ")}`) };
  },
});
