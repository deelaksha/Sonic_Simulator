"use client";
/**
 * Interactive networking explanations for a selected timeline event. These are
 * PURE renderers — every value comes from the engine-computed `detail` snapshot
 * on the event (spec: engine computes, UI displays). No lookups happen here.
 */
import {
  MacLearnDetail,
  MacLookupDetail,
  RouteLookupDetail,
  ArpLookupDetail,
} from "@/lib/engine";
import { Frame, encapsulationStack } from "@/lib/models/packet";

// --- small primitives ------------------------------------------------------

function KV({ label, value, tone }: { label: string; value: string; tone?: "accent" | "warn" | "danger" }) {
  const color = tone === "accent" ? "text-accent-2" : tone === "warn" ? "text-amber-400" : tone === "danger" ? "text-red-400" : "text-[#e6edf3]";
  return (
    <div className="flex justify-between gap-3 py-0.5 text-[11.5px]">
      <span className="text-[#8b98a5]">{label}</span>
      <span className={`text-right font-mono ${color}`}>{value}</span>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-edge bg-panel-2">
      <div className="border-b border-edge px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-2">
        {title}
      </div>
      <div className="px-2.5 py-2">{children}</div>
    </div>
  );
}

function Chip({ text, tone = "default" }: { text: string; tone?: "default" | "in" | "out" }) {
  const cls =
    tone === "in"
      ? "border-accent/60 text-accent-2"
      : tone === "out"
        ? "border-green-500/60 text-green-400"
        : "border-edge text-[#c9d3de]";
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[10.5px] ${cls}`}>{text}</span>;
}

function Why({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-[#8b98a5]">
      <span className="font-semibold text-[#c9d3de]">Why? </span>
      {children}
    </div>
  );
}

// --- MAC table -------------------------------------------------------------

export function MacLookupView({
  detail,
  deviceName,
}: {
  detail: MacLearnDetail | MacLookupDetail;
  deviceName: string;
}) {
  const isLearn = detail.kind === "mac-learn";
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[12px] font-semibold text-[#e6edf3]">
        🔀 Switch <span className="text-accent-2">{deviceName}</span> —{" "}
        {isLearn ? "Source MAC learning (L2)" : "Destination MAC lookup (L2)"}
      </div>

      <SectionCard title="Frame">
        <KV label="Ingress port" value={detail.ingressInterface} />
        <KV label="Source MAC" value={detail.sourceMac} />
        {!isLearn && <KV label="Destination MAC" value={detail.destinationMac} />}
        <KV label="VLAN" value={String(detail.vlan)} />
      </SectionCard>

      {isLearn && (
        <SectionCard title="Step — learn source">
          <div className="flex items-center gap-2 text-[11.5px]">
            <Chip text={detail.sourceMac} />
            <span className="text-[#6b7789]">→</span>
            <Chip text={detail.ingressInterface} tone="in" />
            <span className="text-[#6b7789]">·</span>
            <span className={detail.moved ? "text-amber-400" : "text-green-400"}>
              {detail.moved ? "MAC moved to new port" : "added to MAC table"}
            </span>
          </div>
        </SectionCard>
      )}

      <MacTable rows={detail.macTable} />

      {!isLearn && <MacLookupResult detail={detail} />}

      <Why>
        {isLearn ? (
          <>
            The switch read the <span className="text-accent-2">source MAC</span> from the incoming
            frame and associated it with the ingress port. Future frames destined to this MAC can now
            be forwarded to a single port instead of flooded.
          </>
        ) : detail.result === "found" ? (
          <>
            The destination MAC was found in the table on{" "}
            <span className="text-accent-2">{detail.outputInterfaces[0]}</span>, so the frame is
            forwarded out that one port only.
          </>
        ) : detail.result === "broadcast" || detail.result === "multicast" ? (
          <>
            The destination is a {detail.result} address, so the switch floods the frame to every
            other port in the VLAN.
          </>
        ) : (
          <>
            The destination MAC is not yet in the table (unknown unicast), so the switch floods it to
            all other ports in the VLAN and learns the reply.
          </>
        )}
      </Why>
    </div>
  );
}

function MacTable({ rows }: { rows: MacLearnDetail["macTable"] }) {
  return (
    <SectionCard title="MAC address table">
      {rows.length === 0 ? (
        <div className="text-[11px] text-[#6b7789]">(empty)</div>
      ) : (
        <table className="w-full font-mono text-[11px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-[#6b7789]">
              <th className="pb-1 font-medium">MAC address</th>
              <th className="pb-1 font-medium">Port</th>
              <th className="pb-1 font-medium">VLAN</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.isNew ? "row-new" : ""}>
                <td className="py-0.5 pr-2 text-[#e6edf3]">{r.mac}</td>
                <td className="py-0.5 pr-2 text-accent-2">{r.port}</td>
                <td className="py-0.5 text-[#8b98a5]">{r.vlan}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

function MacLookupResult({ detail }: { detail: MacLookupDetail }) {
  const found = detail.result === "found";
  return (
    <SectionCard title="Lookup result">
      <div className="mb-1.5 flex items-center gap-2 text-[11.5px]">
        <span className="text-[#8b98a5]">Looking for</span>
        <Chip text={detail.destinationMac} />
        <span className="text-[#6b7789]">→</span>
        <span className={found ? "font-semibold text-green-400" : "font-semibold text-amber-400"}>
          {found ? "FOUND" : detail.result === "unknown-unicast" ? "NOT FOUND" : detail.result.toUpperCase()}
        </span>
      </div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
        <span className="text-[#8b98a5]">Action:</span>
        <span className={`font-semibold ${found ? "text-green-400" : "text-amber-400"}`}>
          {detail.action.toUpperCase()}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip text={detail.ingressInterface} tone="in" />
        <span className="text-[#6b7789]">→</span>
        {detail.outputInterfaces.length === 0 ? (
          <span className="text-[11px] text-[#6b7789]">(no eligible ports)</span>
        ) : (
          detail.outputInterfaces.map((p) => <Chip key={p} text={p} tone="out" />)
        )}
      </div>
    </SectionCard>
  );
}

// --- Routing ---------------------------------------------------------------

export function RouteLookupView({
  detail,
  deviceName,
}: {
  detail: RouteLookupDetail;
  deviceName: string;
}) {
  const matched = detail.result === "matched";
  const containing = detail.routingTable.filter((r) => r.contains).length;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[12px] font-semibold text-[#e6edf3]">
        🧭 <span className="text-accent-2">{deviceName}</span> — Routing lookup (L3)
      </div>

      <SectionCard title="Destination IP">
        <div className="font-mono text-[13px] text-[#e6edf3]">{detail.destinationIp}</div>
      </SectionCard>

      <SectionCard title="Routing table">
        {detail.routingTable.length === 0 ? (
          <div className="text-[11px] text-[#6b7789]">(no routes)</div>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-[#6b7789]">
                <th className="pb-1 font-medium"> </th>
                <th className="pb-1 font-medium">Destination</th>
                <th className="pb-1 font-medium">Next hop</th>
                <th className="pb-1 font-medium">Iface</th>
              </tr>
            </thead>
            <tbody>
              {detail.routingTable.map((r, i) => (
                <tr key={i} className={r.matched ? "row-match" : ""}>
                  <td className="py-0.5 pr-1 text-center">
                    {r.matched ? (
                      <span className="text-green-400">★</span>
                    ) : r.contains ? (
                      <span className="text-accent-2">✓</span>
                    ) : (
                      <span className="text-[#3a4453]">·</span>
                    )}
                  </td>
                  <td className="py-0.5 pr-2 text-[#e6edf3]">
                    {r.destination}/{r.prefix}
                  </td>
                  <td className="py-0.5 pr-2 text-[#8b98a5]">{r.nextHop ?? "connected"}</td>
                  <td className="py-0.5 text-accent-2">{r.iface}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-1.5 text-[10.5px] text-[#6b7789]">
          ✓ = prefix contains the destination · ★ = longest-prefix winner
          {containing > 1 ? ` · ${containing} routes matched, most specific wins` : ""}
        </div>
      </SectionCard>

      <SectionCard title="Forwarding decision">
        {matched ? (
          <>
            <KV label="Outgoing interface" value={detail.outputInterface ?? "?"} tone="accent" />
            <KV label="Next hop" value={detail.nextHop ?? "connected (on-link)"} />
          </>
        ) : (
          <div className="text-[12px] font-semibold text-red-400">NO ROUTE — destination unreachable</div>
        )}
      </SectionCard>

      <Why>
        {matched ? (
          <>
            The router compared the destination against every route and picked the{" "}
            <span className="text-accent-2">longest prefix</span> that contains it, then forwards out{" "}
            <span className="text-accent-2">{detail.outputInterface}</span>
            {detail.nextHop ? (
              <>
                {" "}
                toward next hop <span className="text-accent-2">{detail.nextHop}</span>.
              </>
            ) : (
              <> (the destination is directly connected).</>
            )}
          </>
        ) : (
          <>No route in the table contains {detail.destinationIp}, and there is no default route, so
          the packet is dropped and the sender is told the destination is unreachable.</>
        )}
      </Why>
    </div>
  );
}

// --- ARP -------------------------------------------------------------------

export function ArpLookupView({
  detail,
  deviceName,
}: {
  detail: ArpLookupDetail;
  deviceName: string;
}) {
  const miss = detail.result === "miss";
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[12px] font-semibold text-[#e6edf3]">
        <span className="text-accent-2">{deviceName}</span> — ARP lookup (L2 ↔ L3)
      </div>

      <SectionCard title="Target IP">
        <div className="font-mono text-[13px] text-[#e6edf3]">{detail.targetIp}</div>
      </SectionCard>

      <SectionCard title="ARP cache">
        {detail.arpTable.length === 0 ? (
          <div className="text-[11px] text-[#6b7789]">(empty)</div>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-[#6b7789]">
                <th className="pb-1 font-medium">IP address</th>
                <th className="pb-1 font-medium">MAC address</th>
                <th className="pb-1 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {detail.arpTable.map((r, i) => (
                <tr key={i} className={r.matched ? "row-match" : ""}>
                  <td className="py-0.5 pr-2 text-[#e6edf3]">{r.ip}</td>
                  <td className="py-0.5 pr-2 text-accent-2">
                    {r.state === "incomplete" ? "—" : r.mac}
                  </td>
                  <td className={`py-0.5 ${r.state === "reachable" ? "text-green-400" : "text-amber-400"}`}>
                    {r.state.toUpperCase()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard title="Result">
        {miss ? (
          <div className="text-[11.5px]">
            <div className="font-semibold text-amber-400">ARP CACHE MISS</div>
            <div className="mt-1 text-[#c9d3de]">
              {detail.targetIp} is not known → broadcasting{" "}
              <span className="font-mono text-accent-2">Who has {detail.targetIp}?</span>
            </div>
          </div>
        ) : (
          <div className="text-[11.5px]">
            <span className="font-semibold text-green-400">RESOLVED</span>
            <span className="ml-2 font-mono text-[#c9d3de]">
              {detail.targetIp} is at {detail.resolvedMac}
            </span>
          </div>
        )}
      </SectionCard>

      <Why>
        To put an IP packet into an Ethernet frame the sender needs the destination&apos;s{" "}
        <span className="text-accent-2">MAC address</span>. ARP maps the L3 IP to an L2 MAC:{" "}
        {miss
          ? "on a cache miss it broadcasts a request and waits for the owner to reply."
          : "the mapping is now cached, so no ARP is needed for subsequent packets."}
      </Why>
    </div>
  );
}

// --- Encapsulation ---------------------------------------------------------

export function EncapsulationView({ frame }: { frame: Frame }) {
  // inner → outer (encapsulation order, top-down)
  const stack = [...encapsulationStack(frame)].reverse();
  return (
    <SectionCard title="Encapsulation">
      <div className="flex flex-col items-center gap-1">
        {stack.map((layer, i) => (
          <div key={i} className="flex flex-col items-center">
            <span className="rounded border border-edge bg-panel px-3 py-1 text-[11px] text-[#e6edf3]">
              {layer}
            </span>
            {i < stack.length - 1 && <span className="text-[#6b7789]">↓</span>}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
