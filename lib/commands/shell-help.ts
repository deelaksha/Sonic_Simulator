/**
 * `?` context help for the Linux / Click shell (the KLISH grammar has its own,
 * lib/sonic/grammar.ts helpFor). Lists what may follow the text typed so far,
 * filtered by the partial word at the cursor, in KLISH's two-column layout:
 *
 *   ?                → every command
 *   sh?              → commands starting with "sh"
 *   show ip ?        → `show ip …` sub-commands registered by the feature modules
 *   ping -c 3 ?      → remaining options / arguments, parsed from the command's usage
 *
 * Real SONiC's bash shell has no `?` help (Click offers `-h`/`--help`); this is a
 * simulator learning aid. `<cr>` means the command is complete as typed.
 */
import { commandNames, resolveCommand } from "./registry";
import { sonicCommandTree } from "./sonic";
import { splitTyped } from "../sonic/grammar";

export interface HelpItem {
  token: string;
  help: string;
}

const startsCi = (s: string, p: string) => s.toLowerCase().startsWith(p.toLowerCase());

export function shellHelp(line: string): HelpItem[] {
  const { typed, partial } = splitTyped(line);
  if (typed[0] === "sudo") return shellHelp(line.replace(/^\s*sudo\s*/, ""));
  if (typed.length === 0) {
    return commandNames()
      .filter((n) => startsCi(n, partial))
      .map((n) => ({ token: n, help: resolveCommand(n)?.summary ?? "" }));
  }
  const handler = resolveCommand(typed[0]);
  if (!handler) return [];
  const args = typed.slice(1);
  const items = handler.name === "show" || handler.name === "config" ? treeHelp(handler.name, args) : usageHelp(handler.name, handler.usage, handler.summary, args);
  // <cr> only applies to the words already typed, not to a half-typed one
  return items.filter((i) => (i.token.startsWith("<") && !(i.token === "<cr>" && partial)) || startsCi(i.token, partial));
}

/** `show` / `config`: next tokens of every registered path that extends what was typed. */
function treeHelp(verb: "show" | "config", args: string[]): HelpItem[] {
  const cmds = sonicCommandTree(verb);
  const typedLc = args.map((a) => a.toLowerCase());
  const next = new Map<string, string>();
  let exact: string | undefined;
  let beyond: string | undefined;
  for (const c of cmds) {
    const p = c.path.map((t) => t.toLowerCase());
    const n = Math.min(p.length, typedLc.length);
    if (p.slice(0, n).join(" ") !== typedLc.slice(0, n).join(" ")) continue;
    if (p.length > typedLc.length) {
      const tok = c.path[typedLc.length];
      // Prefer the summary of the command that ends at this token.
      if (!next.has(tok) || p.length === typedLc.length + 1) next.set(tok, c.summary);
    } else if (p.length === typedLc.length) exact = c.summary;
    else if (beyond === undefined) beyond = c.summary; // typed past a full path: free arguments
  }
  const items = [...next.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([token, help]) => ({ token, help }));
  if (beyond !== undefined && !items.length && exact === undefined) items.push({ token: "<args>", help: beyond });
  if (exact !== undefined) items.push({ token: "<cr>", help: exact });
  return items;
}

interface Opt {
  flag: string;
  value?: string;
}
interface Word {
  /** Literal choices ("addr|link") or one <placeholder>. */
  w: string;
  optional: boolean;
}
interface Alt {
  words: Word[];
  opts: Opt[];
}

/** Parse a usage string like "ping [-c count] [-s size] <destination> | ping6 …" into alternatives. */
function parseUsage(name: string, usage: string): Alt[] {
  // "{ a | b }" and "[ a | b ]" → "a|b" / "[a|b]"
  const norm = usage
    .replace(/\{\s*([^}]*?)\s*\}/g, (_m, inner: string) => inner.split(/\s*\|\s*/).join("|"))
    .replace(/\[\s*([^\]]*?\s\|\s[^\]]*?)\s*\]/g, (_m, inner: string) => `[${inner.split(/\s*\|\s*/).join("|")}]`);
  // Alternatives are separated by " | " where the next part restarts with the command name.
  const parts = norm.split(new RegExp(`\\s+\\|\\s+(?=${name.replace(/-/g, "\\-")}\\b)`));
  return parts.map((part) => {
    const alt: Alt = { words: [], opts: [] };
    const toks = part.trim().split(/\s+/).slice(1); // drop the command name
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.startsWith("[")) {
        // The whole bracket group: [-c count], [-S|-A|-F], [-i u<usec>|<sec>], [<ip>], [show|add]
        let group = t;
        let depth = (t.match(/\[/g) ?? []).length - (t.match(/\]/g) ?? []).length;
        while (depth > 0 && i + 1 < toks.length) {
          group += " " + toks[++i];
          depth += (toks[i].match(/\[/g) ?? []).length - (toks[i].match(/\]/g) ?? []).length;
        }
        const inner = group.replace(/^\[|\]$/g, "").trim().split(/\s+/);
        if (inner[0].startsWith("-")) {
          for (const f of inner[0].split("|")) alt.opts.push({ flag: f, value: inner.slice(1).join(" ").replace(/[[\]]/g, "") || undefined });
        } else alt.words.push({ w: inner[0].replace(/\.\.\.$/, ""), optional: true });
        continue;
      }
      const w = t.replace(/\.\.\.$/, "");
      if (!w) continue;
      if (w.startsWith("-")) {
        // a required flag with its value: "-c <host>", "-l <port>"
        const v = toks[i + 1]?.startsWith("<") ? toks[++i].replace(/[<>]/g, "") : undefined;
        alt.opts.push({ flag: w, value: v });
      } else alt.words.push({ w, optional: false });
    }
    return alt;
  });
}

const isPlaceholder = (w: string) => w.startsWith("<");

/** Other commands: options not used yet, the next positional word, and <cr> when complete. */
function usageHelp(name: string, usage: string, summary: string, args: string[]): HelpItem[] {
  const out = new Map<string, string>();
  const values = new Map<string, string>(); // an option's value is due next: only that is valid
  let complete = false;
  for (const alt of parseUsage(name, usage)) {
    let pos = 0;
    let ok = true;
    let awaiting: Opt | undefined; // option typed last whose value is still missing
    const used = new Set<string>();
    for (let i = 0; i < args.length && ok; i++) {
      const a = args[i];
      const opt = alt.opts.find((o) => o.flag === a);
      if (opt) {
        used.add(opt.flag);
        if (opt.value) {
          if (i + 1 >= args.length) awaiting = opt;
          i++;
        }
        continue;
      }
      if (a.startsWith("-")) {
        ok = false; // a flag this form of the command doesn't take
        break;
      }
      // optional words that don't match are skipped
      while (pos < alt.words.length && alt.words[pos].optional && !isPlaceholder(alt.words[pos].w) && !alt.words[pos].w.split("|").includes(a)) pos++;
      const word = alt.words[pos];
      if (word === undefined) continue; // trailing free arguments (expression, message…)
      if (!isPlaceholder(word.w) && !word.w.split("|").some((l) => l.toLowerCase() === a.toLowerCase())) ok = false;
      pos++;
    }
    if (!ok) continue;
    if (awaiting) {
      values.set(`<${awaiting.value}>`, `value for ${awaiting.flag}`);
      continue;
    }
    // next words: the first required one, plus any optional ones before it
    let k = pos;
    for (; k < alt.words.length; k++) {
      const word = alt.words[k];
      if (isPlaceholder(word.w)) out.set(word.w, summary);
      else for (const l of word.w.split("|")) out.set(l, "");
      if (!word.optional) break;
    }
    if (k >= alt.words.length) complete = true;
    for (const o of alt.opts) if (!used.has(o.flag)) out.set(o.flag, o.value ? `<${o.value}>` : "");
  }
  if (values.size) return [...values.entries()].map(([token, help]) => ({ token, help }));
  const items = [...out.entries()].map(([token, help]) => ({ token, help }));
  if (complete) items.push({ token: "<cr>", help: summary });
  // Nothing in the usage fits what was typed: show the usage itself.
  return items.length ? items : [{ token: "<args>", help: usage }];
}
