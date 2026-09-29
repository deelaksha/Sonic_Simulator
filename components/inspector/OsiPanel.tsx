"use client";

const LAYERS: { n: number; name: string; example: string }[] = [
  { n: 7, name: "Application", example: "HTTP · DNS · DHCP · NTP" },
  { n: 6, name: "Presentation", example: "TLS · encoding" },
  { n: 5, name: "Session", example: "sockets" },
  { n: 4, name: "Transport", example: "TCP · UDP" },
  { n: 3, name: "Network", example: "IPv4 · ICMP · routing" },
  { n: 2, name: "Data Link", example: "Ethernet · ARP · VLAN · MAC" },
  { n: 1, name: "Physical", example: "cable · signal" },
];

export function OsiPanel({ active }: { active: number[] }) {
  const set = new Set(active);
  return (
    <div>
      <div className="mb-1 flex flex-col gap-0.5">
        {LAYERS.map((l) => {
          const on = set.has(l.n);
          return (
            <div
              key={l.n}
              className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] ${
                on ? "bg-accent-2/15 text-accent-2" : "text-[#5f6b7a]"
              }`}
            >
              <span className="w-5 shrink-0 font-semibold">L{l.n}</span>
              <span className="w-24 shrink-0">{l.name}</span>
              <span className="truncate text-[10px] opacity-80">{l.example}</span>
            </div>
          );
        })}
      </div>
      <p className="px-1 text-[10px] leading-relaxed text-[#5f6b7a]">
        Highlighted layers are involved in the selected event. Note: OSI layers 5/6 rarely map
        one-to-one onto real TCP/IP stacks.
      </p>
    </div>
  );
}
