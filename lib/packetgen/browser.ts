/**
 * Browser access to the packet engine: one lazily-started Scapy worker shared by
 * the whole app. The first call pays the Pyodide + Scapy start-up (~5-8 s);
 * later calls take milliseconds.
 */
import { ScapyEngine, Transport } from "./engine";

class WorkerTransport implements Transport {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./scapy.worker.ts", import.meta.url));
    w.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: string; error?: string }>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result as string);
      else p.reject(new Error(ev.data.error));
    };
    w.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || "packet engine worker failed"));
      this.pending.clear();
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  call(fn: Parameters<Transport["call"]>[0], args: string[]): Promise<string> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ensure().postMessage({ id, fn, args });
    });
  }
}

let engine: ScapyEngine | null = null;

export function packetEngine(): ScapyEngine {
  engine ??= new ScapyEngine(new WorkerTransport());
  return engine;
}
