/**
 * Modal sonic-cli behaviour registry. Each SONiC feature registers a handler for
 * the config commands it owns in a given VIEW (mode). The core engine
 * (lib/commands/sonic-cli.ts) handles navigation + mode entry + `show`/`ping`
 * delegation and then consults these handlers for in-view config commands.
 *
 * Feature handlers live in ./features/<feature>.ts — one file per feature — so
 * many can be implemented in parallel without touching shared files. They mutate
 * the device model (the simulated CONFIG_DB) and/or delegate to the existing,
 * tested Click commands via `a.delegate`.
 */
import { CommandContext, OutputLine } from "../types";

export interface ModalArgs {
  ctx: CommandContext;
  view: string; // grammar view, e.g. "configure-view", "configure-if-view", "configure-vlan-view"
  ifname?: string; // interface context when inside an if-view (e.g. "Ethernet0", "Vlan10", "PortChannel1")
  viewctx?: string; // context set on entering a sub-view (e.g. the BGP AS, route-map name, ACL name)
  head: string; // first keyword (lower-cased; the keyword AFTER a leading "no")
  isNo: boolean; // command began with "no"
  args: string[]; // tokens after the head keyword (with "no" stripped)
  raw: string; // the full raw line
  delegate: (clickCommand: string) => OutputLine[]; // run an existing Click command
}

/** null = not handled (fall through to the next handler / grammar fallback). */
export type ModalResult = { output: OutputLine[]; enter?: string } | null;

export interface ModalHandler {
  id: string; // feature id (matches lib/commands/sonic module id where applicable)
  views: string[]; // grammar views this handler serves
  keywords: string[]; // first keywords it claims, e.g. ["vlan"], ["switchport","shutdown","mtu"]
  run(a: ModalArgs): ModalResult;
}

export const MODAL_HANDLERS: ModalHandler[] = [];

export function registerModal(h: ModalHandler): void {
  MODAL_HANDLERS.push(h);
}

/** Find the first registered handler that claims (view, head) and returns output. */
export function runModalHandlers(a: ModalArgs): ModalResult {
  for (const h of MODAL_HANDLERS) {
    if (!h.views.includes(a.view)) continue;
    if (!h.keywords.includes(a.head)) continue;
    const r = h.run(a);
    if (r) return r;
  }
  return null;
}
