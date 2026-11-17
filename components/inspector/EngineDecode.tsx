"use client";
/**
 * Full protocol decode of an engine-built frame, produced by the packet engine
 * (Scapy) from the frame's bytes as they were on the wire at this hop.
 */
import { useEffect, useState } from "react";
import { Frame } from "@/lib/models/packet";
import { frameToBytes } from "@/lib/sflow/wire";
import { packetEngine } from "@/lib/packetgen/browser";
import { Dissection } from "@/lib/packetgen/engine";

const cache = new Map<string, Dissection>();

export function EngineDecode({ frame }: { frame: Frame }) {
  const [result, setResult] = useState<Dissection | null>(cache.get(frame.id) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache.has(frame.id)) return setResult(cache.get(frame.id)!);
    let live = true;
    setResult(null);
    setError(null);
    packetEngine()
      .dissect(frameToBytes(frame))
      .then((d) => {
        cache.set(frame.id, d);
        if (live) setResult(d);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [frame]);

  return (
    <div className="rounded-md border border-edge bg-panel-2 p-2.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#8b98a5]">Decoded by Scapy</div>
      {error && <div className="text-[11px] text-red-400">{error}</div>}
      {!result && !error && <div className="text-[11px] text-[#6b7789]">Decoding… (first use loads the packet engine)</div>}
      {result && (
        <>
          <div className="mb-1.5 text-[11px] text-[#c9d3de]">{result.summary}</div>
          {result.layers.map((l, i) => (
            <details key={i} className="mb-1 rounded border border-edge">
              <summary className="cursor-pointer px-2 py-1 text-[11px] font-semibold text-[#e6edf3]">{l.name}</summary>
              <div className="px-2 pb-1">
                {l.fields.map((f) => (
                  <div key={f.name} className="flex justify-between gap-2 text-[10.5px]">
                    <span className="text-[#6b7789]">{f.name}</span>
                    <span className="break-all text-right font-mono text-[#c9d3de]">{f.value}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </>
      )}
    </div>
  );
}
