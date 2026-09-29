/**
 * Loads the real Broadcom/Dell Enterprise SONiC KLISH grammar (captured from the
 * live device, compiled by scripts/compile-klish-grammar.ts) and drives the
 * modal CLI's command tree, `?` help and Tab-completion straight from it — so the
 * simulator's command surface matches the device instead of being hand-guessed.
 */
export interface GParam {
  name: string;
  help: string;
  ptype?: string;
  optional?: boolean;
  mode?: string;
  view?: string;
  viewid?: string;
}
export interface GCommand {
  name: string; // full space-separated keyword path, e.g. "show interface status"
  help: string;
  view?: string; // target mode this command switches to
  viewid?: string;
  params?: GParam[];
}

interface SlimGrammar {
  views: Record<string, GCommand[]>;
  viewMeta: Record<string, { prompt?: string; depth?: string }>;
}

// The 1.5MB grammar is loaded at runtime (public/sonic-cli-grammar.json in the
// browser, fs in tests) rather than bundled — see setGrammar/loadGrammarBrowser.
let GRAMMAR: SlimGrammar = { views: {}, viewMeta: {} };

export function setGrammar(g: SlimGrammar): void {
  GRAMMAR = g;
}
export function isGrammarLoaded(): boolean {
  return Object.keys(GRAMMAR.views).length > 0;
}

/** Fetch + install the grammar in the browser (idempotent). */
let loadPromise: Promise<void> | null = null;
export function loadGrammarBrowser(): Promise<void> {
  if (isGrammarLoaded()) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = fetch("/sonic-cli-grammar.json")
      .then((r) => r.json())
      .then((g: SlimGrammar) => setGrammar(g))
      .catch(() => { loadPromise = null; });
  }
  return loadPromise;
}

export const VIEW_META = new Proxy({} as Record<string, { prompt?: string; depth?: string }>, {
  get: (_t, k: string) => GRAMMAR.viewMeta[k],
});

/** Map an internal mode-stack top ("exec"/"config"/"if-Ethernet0") to a grammar VIEW. */
export function viewForStackTop(top: string | undefined): string {
  if (!top || top === "exec") return "enable-view";
  if (top.startsWith("gv:")) return top.slice(3).split("|")[0]; // generic sub-view frame
  if (top === "config") return "configure-view";
  if (top.startsWith("if-Vlan")) return "configure-vlan-view";
  if (top.startsWith("if-Loopback")) return "configure-lo-view";
  if (top.startsWith("if-PortChannel") || top.startsWith("if-po") || top.startsWith("if-PO")) return "configure-lag-view";
  if (top.startsWith("if-Management")) return "configure-if-mgmt-view";
  if (top.startsWith("if-")) return "configure-if-view";
  if (top.startsWith("view:")) return top.slice(5); // explicit grammar view
  return "enable-view";
}

export function commandsForView(view: string): GCommand[] {
  return GRAMMAR.views[view] ?? [];
}

/** Build a sub-view stack frame for a feature handler's `enter` (with optional context). */
export function subViewFrame(targetView: string, ctx = ""): string {
  return `gv:${targetView}|${promptBodyFor(targetView)}|${ctx}`;
}

/** The prompt "(...)" body for a target view, e.g. "config-router-bgp". */
export function promptBodyFor(targetView: string): string {
  const tmpl = VIEW_META[targetView]?.prompt;
  if (tmpl) {
    const inner = tmpl.match(/\(([^)]*)\)/)?.[1] ?? "";
    return inner.replace(/\$\{__config_mode\}/g, "config").replace(/\$\{[^}]+\}/g, "").replace(/-+$/, "");
  }
  return "config-" + targetView.replace(/^configure-/, "").replace(/-view$/, "");
}

/**
 * If the typed command in `view` is a mode-entry command (grammar has a target
 * `view`), return the sub-view to enter, its prompt body, and the trailing
 * context args. Data-driven from the real device grammar (COMMAND view=...).
 */
export function resolveModeEntry(view: string, tokens: string[]): { targetView: string; promptBody: string; ctx: string } | null {
  let best: GCommand | null = null;
  for (const c of commandsForView(view)) {
    if (!c.view) continue;
    const kw = c.name.split(/\s+/);
    if (kw.length <= tokens.length && kw.every((k, i) => k.toLowerCase() === tokens[i].toLowerCase())) {
      if (!best || kw.length > best.name.split(/\s+/).length) best = c;
    }
  }
  if (!best || !best.view) return null;
  const kwLen = (best as GCommand).name.split(/\s+/).length;
  return { targetView: (best as GCommand).view!, promptBody: promptBodyFor((best as GCommand).view!), ctx: tokens.slice(kwLen).join(" ") };
}

/** True when the typed line matches a real command's keyword path in this view. */
export function isKnownCommand(view: string, line: string): boolean {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  // "no <cmd>" is valid if "<cmd>" (or "no <cmd>") is known. (case-insensitive)
  const candidates = toks[0].toLowerCase() === "no" ? [toks, toks.slice(1)] : [toks];
  return commandsForView(view).some((c) => {
    const kw = c.name.split(/\s+/);
    return candidates.some((t) => kw.length <= t.length && kw.every((k, i) => k.toLowerCase() === t[i].toLowerCase()));
  });
}

export interface Candidate {
  token: string; // literal keyword, or a "<ptype>" placeholder for an argument
  help: string;
  placeholder: boolean; // true when it represents an argument value, not a literal to complete
}

/**
 * Interface-selector ptypes complete to TYPE KEYWORDS, not a free value. On the
 * device these are KLISH "switch" alternatives (e.g. `interface ?` → Ethernet /
 * Vlan / Loopback / PortChannel / Management). Ptype names encode the allowed
 * types as abbreviations, e.g. PHY_INTERFACE, PHY_PO_INTERFACE (Ethernet +
 * PortChannel), PHY_VL_PO_LB_INTERFACE, VLAN_INTERFACE_RANGE, PHY_INTERFACE_SUBIF.
 * VLAN_ID / VLAN_RANGE are NOT selectors (plain numbers) — they lack "INTERFACE".
 */
const IF_ABBR: Record<string, string> = {
  PHY: "Ethernet", ETH: "Ethernet", ETHER: "Ethernet",
  VL: "Vlan", VLAN: "Vlan",
  PO: "PortChannel",
  LB: "Loopback", LOOPBACK: "Loopback",
  MGMT: "Management",
};

/** Type keywords a ptype offers (empty unless it is an interface selector). */
function interfaceKeywords(ptype: string | undefined): string[] {
  if (!ptype) return [];
  const p = ptype.toUpperCase();
  if (p === "FRONT_PANEL_PORT") return ["Ethernet"];
  if (!/INTERFACE|SUBIF/.test(p)) return [];
  const kws: string[] = [];
  for (const t of p.split("_")) {
    const k = IF_ABBR[t];
    if (k && !kws.includes(k)) kws.push(k);
  }
  return kws;
}

/** Case-insensitive equality / prefix (the CLI accepts either case). */
const eqi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const startsCi = (tok: string, pfx: string): boolean => tok.toLowerCase().startsWith(pfx.toLowerCase());

/**
 * Given a mode view and the tokens already typed, return the set of possible
 * NEXT tokens (keywords + argument placeholders) with help — the basis for both
 * `?` help and Tab-completion.
 */
export function candidatesFor(view: string, typed: string[]): Candidate[] {
  const cmds = commandsForView(view);
  const out = new Map<string, Candidate>();
  for (const c of cmds) {
    const kw = c.name.split(/\s+/);
    // Case 1: still inside the keyword path → suggest the next keyword.
    if (typed.length < kw.length) {
      if (kw.slice(0, typed.length).every((k, i) => eqi(k, typed[i]))) {
        const tok = kw[typed.length];
        if (!out.has(tok)) out.set(tok, { token: tok, help: c.help, placeholder: false });
      }
      continue;
    }
    // Case 2: keywords fully matched → suggest the next parameter (argument).
    if (kw.every((k, i) => eqi(k, typed[i]))) {
      const params = c.params ?? [];
      const idx = typed.length - kw.length;
      // First-arg interface/object types are KLISH "switch" alternatives: emit
      // each as its type keyword (Ethernet / Vlan / Loopback / PortChannel / ...).
      if (idx === 0) {
        let emitted = false;
        for (const p of params) {
          for (const kwName of interfaceKeywords(p.ptype)) {
            emitted = true;
            if (!out.has(kwName)) out.set(kwName, { token: kwName, help: p.help || kwName, placeholder: false });
          }
        }
        if (emitted) continue; // this command's first-arg alternatives are handled
      }
      if (idx < params.length) {
        const p = params[idx];
        // A subcommand-mode param is really another literal keyword.
        const literal = p.mode === "subcommand" || p.ptype === "SUBCOMMAND";
        const tok = literal ? p.name : `<${(p.ptype ?? p.name).toLowerCase()}>`;
        const key = tok + (literal ? "" : `:${p.name}`);
        if (!out.has(key)) out.set(key, { token: tok, help: p.help || p.name, placeholder: !literal });
      } else if (idx === params.length && params.length >= 0) {
        // command is complete here → offer <cr>
        if (!out.has("<cr>")) out.set("<cr>", { token: "<cr>", help: c.help, placeholder: true });
      }
    }
  }
  return [...out.values()];
}

/** Split a raw input line into (completed tokens, current partial token). */
export function splitTyped(line: string): { typed: string[]; partial: string } {
  const endsSpace = line.length > 0 && /\s$/.test(line);
  const toks = line.split(/\s+/).filter(Boolean);
  if (endsSpace || line === "") return { typed: toks, partial: "" };
  return { typed: toks.slice(0, -1), partial: toks[toks.length - 1] ?? "" };
}

/** `?` help: the candidates valid at the cursor, filtered by the current partial (case-insensitive). */
export function helpFor(view: string, line: string): Candidate[] {
  const { typed, partial } = splitTyped(line);
  return candidatesFor(view, typed).filter((c) => c.placeholder || startsCi(c.token, partial));
}

/**
 * Tab-completion (case-insensitive: `eth`/`ETH`/`Eth` all complete to `Ethernet`).
 * Only completes when unambiguous, or to the shared prefix of several matches —
 * it never auto-picks one of several similar commands.
 */
export function completeFor(view: string, line: string): { completed?: string; candidates: Candidate[] } {
  const { typed, partial } = splitTyped(line);
  const all = candidatesFor(view, typed);
  const literals = all.filter((c) => !c.placeholder && startsCi(c.token, partial));
  if (literals.length === 1) return { completed: literals[0].token, candidates: [] };
  // common-prefix (case-insensitive) completion when several share a longer prefix
  if (literals.length > 1) {
    const common = literals.map((l) => l.token).reduce((a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
      return a.slice(0, i);
    });
    // Only extend if it grows the current token; otherwise list (do NOT pick one).
    if (common.length > partial.length) return { completed: common, candidates: literals };
    return { candidates: literals };
  }
  return { candidates: all.filter((c) => c.placeholder) };
}
