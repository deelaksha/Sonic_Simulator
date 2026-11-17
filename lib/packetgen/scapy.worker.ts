/// <reference lib="webworker" />
/**
 * Web Worker hosting Pyodide + Scapy. Everything is loaded from the app's own
 * /packet-engine/ assets (scripts/vendor-packet-engine.mjs) — no CDN, no PyPI.
 * Runs in the visitor's browser sandbox; nothing executes on the server.
 */
import { SCAPY_ENGINE_PY } from "./scapy-source";

declare function importScripts(...urls: string[]): void;
declare function loadPyodide(opts: { indexURL: string }): Promise<Pyodide>;

interface Pyodide {
  loadPackage(names: string | string[]): Promise<void>;
  runPython(code: string): unknown;
  globals: { get(name: string): (...args: string[]) => string };
}

let ready: Promise<Pyodide> | null = null;

async function init(): Promise<Pyodide> {
  const base = new URL("/packet-engine/", self.location.origin).href;
  const manifest = (await (await fetch(`${base}manifest.json`)).json()) as { scapyWheel: string };
  importScripts(`${base}pyodide.js`);
  const py = await loadPyodide({ indexURL: base });
  await py.loadPackage(`${base}${manifest.scapyWheel}`);
  py.runPython(SCAPY_ENGINE_PY);
  return py;
}

/** Python tracebacks are long; the UI only needs the final "Error: message" line. */
function lastLine(e: unknown): string {
  const lines = String((e as Error)?.message ?? e).trim().split("\n");
  return lines[lines.length - 1];
}

self.onmessage = async (ev: MessageEvent<{ id: number; fn: string; args: string[] }>) => {
  const { id, fn, args } = ev.data;
  try {
    // A failed start-up is not cached: the next call retries.
    ready ??= init().catch((e) => {
      ready = null;
      throw e;
    });
    const py = await ready;
    const result = py.globals.get(fn)(...args);
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: lastLine(e) });
  }
};
