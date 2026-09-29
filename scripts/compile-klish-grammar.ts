/**
 * Compile the real Broadcom/Dell Enterprise SONiC KLISH command-tree XML
 * (captured read-only from the live device 192.168.202.172, SONiC-OS 4.5.0)
 * into a single grammar JSON the simulator loads. Dependency-free.
 *
 *   data/device-capture/klish-xml/*.xml  ->  data/sonic-grammar.json
 *
 * Each <COMMAND name="..."> lives in a <VIEW name="..."> (the CLI mode). The
 * command `name` is the full space-separated keyword path; <PARAM>s are the
 * trailing arguments; <ACTION> names the backend; <DOCGEN><EXAMPLE> is a sample.
 * We keep everything so the modal CLI can render the exact tree, help, prompts,
 * tab-completion and `?` help for every command, and wire behaviour per feature.
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const DIR = join(process.cwd(), "data/device-capture/klish-xml");
const OUT = join(process.cwd(), "data/sonic-grammar.json");

interface Param { name: string; help: string; ptype?: string; mode?: string; optional?: boolean; view?: string; viewid?: string }
interface Command { name: string; help: string; access?: string; params: Param[]; action?: string; example?: string; source: string; view?: string; viewid?: string }
interface ViewMeta { prompt?: string; depth?: string }
interface Grammar { generatedFrom: string; views: Record<string, Command[]>; viewMeta: Record<string, ViewMeta>; stats: Record<string, number> }

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]] = (m[2] ?? m[3] ?? "").trim();
  return out;
}

/** Resolve `<!ENTITY NAME "val">` references (&NAME;) in the raw XML text. */
function resolveEntities(xml: string): string {
  const ents: Record<string, string> = {};
  const re = /<!ENTITY\s+(\w+)\s+"([^"]*)"\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) ents[m[1]] = m[2];
  return xml.replace(/&(\w+);/g, (whole, name) => (name in ents ? ents[name] : whole));
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function parseCommand(block: string, openTag: string, source: string): Command {
  const a = attrs(openTag);
  const params: Param[] = [];
  const pre = /<PARAM\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = pre.exec(block))) {
    const pa = attrs(m[1]);
    if (!pa.name) continue;
    params.push({ name: pa.name, help: pa.help ?? "", ptype: pa.ptype, mode: pa.mode, optional: pa.optional === "true", view: pa.view, viewid: pa.viewid });
  }
  const action = /<ACTION\b[^>]*>([\s\S]*?)<\/ACTION>/.exec(block)?.[1];
  const example = /<EXAMPLE>([\s\S]*?)<\/EXAMPLE>/.exec(block)?.[1];
  return {
    name: a.name ?? "",
    help: a.help ?? "",
    access: a.access,
    params,
    action: action ? collapse(action) : undefined,
    example: example ? collapse(example) : undefined,
    source,
    view: a.view,
    viewid: a.viewid,
  };
}

function parseFile(file: string, grammar: Grammar): void {
  let raw: string;
  try {
    raw = readFileSync(join(DIR, file), "utf8");
  } catch {
    return; // dangling symlink / unreadable entry from the container tar
  }
  const xml = resolveEntities(raw);
  const viewRe = /<VIEW\b([^>]*)>([\s\S]*?)<\/VIEW>/g;
  let vm: RegExpExecArray | null;
  while ((vm = viewRe.exec(xml))) {
    const va = attrs(vm[1]);
    const view = va.name;
    if (!view) continue;
    const body = vm[2];
    if (!grammar.viewMeta[view] && (va.prompt || va.depth)) grammar.viewMeta[view] = { prompt: va.prompt, depth: va.depth };
    const list = (grammar.views[view] ??= []);
    // self-closed COMMANDs (no body) and full COMMAND blocks
    const cmdRe = /<COMMAND\b([^>]*?)(?:\/>|>([\s\S]*?)<\/COMMAND>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cmdRe.exec(body))) {
      const cmd = parseCommand(cm[2] ?? "", cm[1], file.replace(/\.xml$/, ""));
      if (cmd.name) list.push(cmd);
    }
  }
}

const grammar: Grammar = { generatedFrom: "Broadcom/Dell Enterprise SONiC-OS 4.5.0 (192.168.202.172)", views: {}, viewMeta: {}, stats: {} };
const files = readdirSync(DIR).filter((f) => f.endsWith(".xml")).sort();
for (const f of files) parseFile(f, grammar);

let total = 0;
for (const [view, cmds] of Object.entries(grammar.views)) {
  grammar.stats[view] = cmds.length;
  total += cmds.length;
}
grammar.stats.__totalCommands = total;
grammar.stats.__files = files.length;

writeFileSync(OUT, JSON.stringify(grammar, null, 2));

// Slim grammar for the client engine: everything needed to render the tree,
// help, prompts, tab-completion, `?` help and mode navigation — no action/example.
const SLIM = join(process.cwd(), "data/sonic-cli-grammar.json");
const slimViews: Record<string, unknown[]> = {};
for (const [view, cmds] of Object.entries(grammar.views)) {
  slimViews[view] = cmds.map((c) => {
    const o: Record<string, unknown> = { name: c.name, help: c.help };
    if (c.view) o.view = c.view;
    if (c.viewid) o.viewid = c.viewid;
    const params = c.params.map((p) => {
      const q: Record<string, unknown> = { name: p.name, help: p.help };
      if (p.ptype) q.ptype = p.ptype;
      if (p.optional) q.optional = true;
      if (p.mode) q.mode = p.mode;
      if (p.view) q.view = p.view;
      if (p.viewid) q.viewid = p.viewid;
      return q;
    });
    if (params.length) o.params = params;
    return o;
  });
}
writeFileSync(SLIM, JSON.stringify({ generatedFrom: grammar.generatedFrom, viewMeta: grammar.viewMeta, views: slimViews }));

console.log(`Compiled ${files.length} XML files → ${total} commands across ${Object.keys(grammar.views).length} views`);
console.log("Top views:", Object.entries(grammar.stats).filter(([k]) => !k.startsWith("__")).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}=${n}`).join(", "));
console.log(`Wrote ${OUT} (full) + ${SLIM} (slim)`);
