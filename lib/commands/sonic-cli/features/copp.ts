/**
 * CoPP (control-plane policing) modal behaviour. configure-view (from
 * data/device-capture/klish-xml/copp.xml):
 *   copp-action <name>      create a CoPP action group
 *   no copp-action <name>   delete a CoPP action group
 * Delegates to the tested Click `config copp action add/del`.
 *
 * In real KLISH `copp-action <name>` ALSO enters `copp-action-view`, where the
 * field-setting commands live (`set trap-action`, `set trap-queue`,
 * `set trap-priority`, `police`, and their `no` forms). That sub-view is a
 * DEDICATED sub-mode the engine cannot enter yet, so this handler only performs
 * the create/delete in configure-view and does NOT navigate into the sub-view;
 * the sub-view field commands are deferred to the sub-mode-entry task.
 *
 * The Click module also supports `config copp classifier ...` and
 * `config copp bind/unbind`, but those have no configure-view KLISH form — in
 * real KLISH classifiers/bindings are configured via the class-map / policy-map
 * dedicated sub-modes — so they are not wired here.
 */
import { err } from "../../types";
import { registerModal } from "../registry";

registerModal({
  id: "copp",
  views: ["configure-view"],
  keywords: ["copp-action"],
  run({ isNo, args, delegate }) {
    const name = args[0];
    if (!name) return { output: [err("% CoPP action group name required.")] };
    return { output: delegate(`config copp action ${isNo ? "del" : "add"} ${name}`) };
  },
});
