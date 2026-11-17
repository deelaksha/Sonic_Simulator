/**
 * Test transport: the same Python engine source and vendored Scapy wheel the
 * browser worker uses, run in-process with Pyodide for Node.
 */
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ScapyEngine, Transport } from "../lib/packetgen/engine";
import { SCAPY_ENGINE_PY } from "../lib/packetgen/scapy-source";

let engine: Promise<ScapyEngine> | null = null;

export function nodePacketEngine(): Promise<ScapyEngine> {
  engine ??= (async () => {
    const assets = join(__dirname, "..", "public", "packet-engine");
    const { scapyWheel } = JSON.parse(readFileSync(join(assets, "manifest.json"), "utf8")) as { scapyWheel: string };
    const py = await loadPyodide({ indexURL: join(__dirname, "..", "node_modules", "pyodide") });
    // Install the vendored wheel from the in-memory FS (no network).
    py.FS.writeFile(`/tmp/${scapyWheel}`, readFileSync(join(assets, scapyWheel)));
    await py.loadPackage("micropip");
    await py.pyimport("micropip").install(`emfs:/tmp/${scapyWheel}`);
    py.runPython(SCAPY_ENGINE_PY);
    const transport: Transport = {
      async call(fn, args) {
        try {
          return py.globals.get(fn)(...args) as string;
        } catch (e) {
          const lines = String((e as Error).message).trim().split("\n");
          throw new Error(lines[lines.length - 1]);
        }
      },
    };
    return new ScapyEngine(transport);
  })();
  return engine;
}
