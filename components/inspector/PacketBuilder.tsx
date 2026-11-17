"use client";
/**
 * Protocol-agnostic packet builder. The layer list comes from the packet
 * engine (`protocols()`), each layer's field editor from `describe()`, and the
 * bytes from `build()` — the simulator itself contains no per-protocol code
 * here. Templates are only preset layer stacks.
 */
import { useEffect, useState } from "react";
import { packetEngine } from "@/lib/packetgen/browser";
import { BuiltPacket, FieldInfo, FieldValue, LayerSpec, ProtocolInfo } from "@/lib/packetgen/engine";

const input = "rounded border border-edge bg-panel px-1.5 py-1 text-[11px] outline-none focus:border-accent-2";

export const TEMPLATES: Record<string, LayerSpec[]> = {
  "DNS query": [
    { proto: "Ether" },
    { proto: "IP" },
    { proto: "UDP", fields: { sport: 33333, dport: 53 } },
    { proto: "DNS", fields: { rd: 1, qd: { proto: "DNSQR", fields: { qname: "example.com" } } } },
  ],
  "DHCP Discover": [
    { proto: "Ether", fields: { dst: "ff:ff:ff:ff:ff:ff" } },
    { proto: "IP", fields: { src: "0.0.0.0", dst: "255.255.255.255" } },
    { proto: "UDP", fields: { sport: 68, dport: 67 } },
    { proto: "BOOTP" },
    { proto: "DHCP", fields: { options: [["message-type", "discover"], "end"] } },
  ],
  "NTP client": [{ proto: "Ether" }, { proto: "IP" }, { proto: "UDP", fields: { sport: 123, dport: 123 } }, { proto: "NTPHeader" }],
  "VXLAN (ICMP inside)": [
    { proto: "Ether" },
    { proto: "IP" },
    { proto: "UDP", fields: { dport: 4789 } },
    { proto: "VXLAN", fields: { vni: 10100 } },
    { proto: "Ether", fields: { src: "02:00:00:00:aa:01", dst: "02:00:00:00:aa:02" } },
    { proto: "IP", fields: { src: "10.1.1.1", dst: "10.1.1.2" } },
    { proto: "ICMP" },
  ],
  "BGP OPEN": [
    { proto: "Ether" },
    { proto: "IP" },
    { proto: "TCP", fields: { sport: 40000, dport: 179, flags: "PA" } },
    { proto: "BGPHeader", fields: { type: 1 } },
    { proto: "BGPOpen", fields: { my_as: 65001, hold_time: 180, bgp_id: "1.1.1.1" } },
  ],
  "GRE (IP in IP)": [{ proto: "Ether" }, { proto: "IP" }, { proto: "GRE" }, { proto: "IP", fields: { src: "10.9.9.1", dst: "10.9.9.2" } }, { proto: "ICMP" }],
  "LLDP": [
    { proto: "Ether", fields: { dst: "01:80:c2:00:00:0e" } },
    { proto: "LLDPDUChassisID", fields: { subtype: 4 } },
    { proto: "LLDPDUPortID", fields: { subtype: 5, id: "eth0" } },
    { proto: "LLDPDUTimeToLive", fields: { ttl: 120 } },
    { proto: "LLDPDUEndOfLLDPDU" },
  ],
  "UDP (custom payload)": [{ proto: "Ether" }, { proto: "IP" }, { proto: "UDP", fields: { sport: 40000, dport: 5001 } }, { proto: "Raw", fields: { load: "hello" } }],
};

export interface Addressing {
  srcMac: string;
  dstMac?: string;
  srcIp?: string;
  dstIp?: string;
}

/** Fill the addresses the user left blank from the selected hosts. */
export function withAddressing(stack: LayerSpec[], a: Addressing): LayerSpec[] {
  let etherDone = false;
  let ipDone = false;
  return stack.map((l) => {
    const fields = { ...(l.fields ?? {}) };
    if (l.proto === "Ether" && !etherDone) {
      etherDone = true;
      fields.src ??= a.srcMac.toLowerCase();
      fields.dst ??= (a.dstMac ?? "ff:ff:ff:ff:ff:ff").toLowerCase();
    }
    if (l.proto === "IP" && !ipDone) {
      ipDone = true;
      if (a.srcIp) fields.src ??= a.srcIp;
      if (a.dstIp) fields.dst ??= a.dstIp;
    }
    return { ...l, fields };
  });
}

/** Text in a field box → engine value (number, JSON for nested packets/lists, else string). */
function parseValue(text: string, f: FieldInfo | undefined): FieldValue {
  const t = text.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && (f?.kind === "packet" || f?.kind === "list" || !f)) {
    try {
      return JSON.parse(t) as FieldValue;
    } catch {
      return t;
    }
  }
  if ((f?.kind === "int" || f?.kind === "enum") && /^-?\d+$/.test(t)) return Number(t);
  return t;
}

const show = (v: FieldValue | undefined) => (v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function LayerEditor({
  layer,
  onChange,
  onRemove,
}: {
  layer: LayerSpec;
  onChange: (l: LayerSpec) => void;
  onRemove: () => void;
}) {
  const [fields, setFields] = useState<FieldInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || fields) return;
    packetEngine()
      .describe(layer.proto)
      .then((d) => setFields(d.fields))
      .catch((e: Error) => setError(e.message));
  }, [open, fields, layer.proto]);

  const set = (name: string, text: string, info?: FieldInfo) => {
    const next = { ...(layer.fields ?? {}) };
    if (text.trim() === "") delete next[name];
    else next[name] = parseValue(text, info);
    onChange({ ...layer, fields: next });
  };
  const assigned = Object.entries(layer.fields ?? {});

  return (
    <div className="rounded border border-edge">
      <div className="flex items-center justify-between px-2 py-1">
        <button className="text-left text-[11px] font-semibold text-[#e6edf3]" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {layer.proto}
          {assigned.length > 0 && (
            <span className="ml-1 font-normal text-[#6b7789]">{assigned.map(([k, v]) => `${k}=${show(v)}`).join(" ").slice(0, 60)}</span>
          )}
        </button>
        <button className="text-[11px] text-[#6b7789] hover:text-red-400" onClick={onRemove} title="Remove layer">
          ✕
        </button>
      </div>
      {open && (
        <div className="grid grid-cols-[96px_1fr] items-center gap-1 px-2 pb-2 text-[10.5px]">
          {error && <div className="col-span-2 text-red-400">{error}</div>}
          {!fields && !error && <div className="col-span-2 text-[#6b7789]">loading fields…</div>}
          {fields?.map((f) => (
            <FieldRow key={f.name} f={f} value={layer.fields?.[f.name]} onChange={(t) => set(f.name, t, f)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FieldRow({ f, value, onChange }: { f: FieldInfo; value: FieldValue | undefined; onChange: (text: string) => void }) {
  const listId = f.choices ? `choices-${f.name}` : undefined;
  return (
    <>
      <span className="truncate text-[#6b7789]" title={`${f.type} (${f.kind})`}>
        {f.name}
      </span>
      <div>
        <input
          className={`${input} w-full`}
          value={show(value)}
          placeholder={f.default === null ? "" : String(f.default)}
          list={listId}
          onChange={(e) => onChange(e.target.value)}
          title={f.kind === "packet" || f.kind === "list" ? 'nested packet as JSON, e.g. {"proto":"DNSQR","fields":{"qname":"a.com"}}' : f.flags ? `flags: ${f.flags.join(" ")}` : f.type}
        />
        {f.choices && (
          <datalist id={listId}>
            {Object.entries(f.choices).map(([k, v]) => (
              <option key={k} value={v}>
                {k}
              </option>
            ))}
          </datalist>
        )}
      </div>
    </>
  );
}

export function PacketBuilder({
  stack,
  onChange,
  addressing,
  disabled,
}: {
  stack: LayerSpec[];
  onChange: (s: LayerSpec[]) => void;
  addressing: Addressing;
  disabled?: boolean;
}) {
  const [protocols, setProtocols] = useState<ProtocolInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [preview, setPreview] = useState<BuiltPacket | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    packetEngine()
      .protocols()
      .then((r) => setProtocols(r.protocols))
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const add = () => {
    if (!protocols?.some((p) => p.proto === adding)) return;
    onChange([...stack, { proto: adding }]);
    setAdding("");
  };

  const doPreview = () => {
    setPreviewError(null);
    packetEngine()
      .build(withAddressing(stack, addressing))
      .then(setPreview)
      .catch((e: Error) => {
        setPreview(null);
        setPreviewError(e.message);
      });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1 text-[11px]">
        <span className="text-[#6b7789]">Template</span>
        <select
          className={`${input} flex-1`}
          value=""
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value) onChange(TEMPLATES[e.target.value].map((l) => ({ ...l, fields: { ...(l.fields ?? {}) } })));
            setPreview(null);
          }}
        >
          <option value="">load a template…</option>
          {Object.keys(TEMPLATES).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>

      {loadError && <div className="text-[10px] text-red-400">packet engine failed to load: {loadError}</div>}
      {!protocols && !loadError && <div className="text-[10px] text-[#8b98a5]">Loading the packet engine (Scapy in WebAssembly, first use ~5-10 s)…</div>}

      {stack.map((l, i) => (
        <LayerEditor
          key={`${i}-${l.proto}`}
          layer={l}
          onChange={(nl) => onChange(stack.map((x, j) => (j === i ? nl : x)))}
          onRemove={() => onChange(stack.filter((_, j) => j !== i))}
        />
      ))}

      <div className="flex gap-1">
        <input
          className={`${input} flex-1`}
          list="engine-protocols"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder={protocols ? `add layer (${protocols.length} protocols)` : "add layer"}
          disabled={!protocols || disabled}
        />
        <datalist id="engine-protocols">
          {protocols?.map((p) => (
            <option key={p.proto} value={p.proto}>
              {p.name} · {p.module}
            </option>
          ))}
        </datalist>
        <button className="rounded border border-edge px-2 text-[11px] text-[#c9d3de]" onClick={add} disabled={!protocols || disabled}>
          Add
        </button>
        <button className="rounded border border-accent/50 bg-accent/15 px-2 text-[11px] text-accent-2" onClick={doPreview} disabled={!protocols || !stack.length}>
          Preview
        </button>
      </div>
      <div className="text-[10px] text-[#5f6b7a]">Blank Ether/IP addresses are filled from the source host and destination.</div>

      {previewError && <div className="text-[10px] text-red-400">{previewError}</div>}
      {preview && (
        <div className="rounded border border-edge bg-panel p-1.5">
          <div className="text-[11px] text-[#c9d3de]">{preview.summary}</div>
          <div className="text-[10px] text-[#6b7789]">{preview.bytes.length} bytes</div>
          <pre className="mt-1 max-h-48 overflow-auto text-[10px] leading-tight text-[#8b98a5]">{preview.show}</pre>
        </div>
      )}
    </div>
  );
}
