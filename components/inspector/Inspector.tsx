"use client";
import { useEffect, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { DeviceConfigPanel } from "./DeviceConfigPanel";
import { PacketInspector } from "./PacketInspector";
import { TrafficPanel } from "./TrafficPanel";
import { SflowPanel } from "./SflowPanel";

type Tab = "device" | "packet" | "traffic" | "sflow";

const TAB_LABEL: Record<Tab, string> = { device: "Device", packet: "Packet", traffic: "Traffic", sflow: "sFlow" };

export function Inspector() {
  const selectedDeviceId = useLabStore((s) => s.selectedDeviceId);
  const selectedEventId = useLabStore((s) => s.selectedEventId);
  const [tab, setTab] = useState<Tab>("device");

  // Follow the user's focus: selecting a packet shows the packet tab, etc.
  useEffect(() => {
    if (selectedEventId) setTab("packet");
  }, [selectedEventId]);
  useEffect(() => {
    if (selectedDeviceId) setTab((t) => (t === "traffic" || t === "sflow" ? t : "device"));
  }, [selectedDeviceId]);

  // The monitoring tabs carry tables, so the inspector widens for them.
  const wide = tab === "traffic" || tab === "sflow";
  return (
    <div className={`flex h-full flex-col ${wide ? "w-[30rem]" : "w-80"}`}>
      <div className="flex border-b border-edge">
        {(["device", "packet", "traffic", "sflow"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wide ${
              tab === t ? "border-b-2 border-accent-2 text-accent-2" : "text-[#6b7789] hover:text-[#c9d3de]"
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "device" ? <DeviceConfigPanel /> : tab === "packet" ? <PacketInspector /> : tab === "traffic" ? <TrafficPanel /> : <SflowPanel />}
      </div>
    </div>
  );
}
