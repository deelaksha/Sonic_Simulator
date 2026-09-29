"use client";
import { useRef, useState } from "react";
import { DeviceType } from "@/lib/models/device";
import { deviceVisual } from "../topology/deviceIcons";
import { useLabStore } from "@/lib/store/lab-store";
import { SonicFeaturePanel } from "./SonicFeaturePanel";

const PALETTE: DeviceType[] = ["pc", "switch", "router", "server", "dhcp-server", "ntp-server", "dns-server", "internet"];
const SWITCH_SIZES = [2, 4, 8, 16, 24, 48];

function PaletteItem({ type, ports }: { type: DeviceType; ports?: number }) {
  const v = deviceVisual(type);
  const addDevice = useLabStore((s) => s.addDevice);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/device-type", type);
        if (ports) e.dataTransfer.setData("application/device-ports", String(ports));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDoubleClick={() => addDevice(type, undefined, ports)}
      title={`Drag onto the canvas, or double-click to add. ${v.label}`}
      className="flex cursor-grab items-center gap-2 rounded-md border border-edge bg-panel-2 px-2.5 py-2 text-sm hover:border-accent-2 active:cursor-grabbing"
    >
      <span className="text-lg leading-none">{v.icon}</span>
      <span className="text-[#e6edf3]">{v.label}</span>
    </div>
  );
}

export function DeviceToolbox() {
  const [switchPorts, setSwitchPorts] = useState(4);
  const newLab = useLabStore((s) => s.newLab);
  const loadSample = useLabStore((s) => s.loadSample);
  const exportLab = useLabStore((s) => s.exportLab);
  const importLab = useLabStore((s) => s.importLab);
  const labName = useLabStore((s) => s.labName);
  const fileRef = useRef<HTMLInputElement>(null);

  const onExport = () => {
    const blob = new Blob([exportLab()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${labName.replace(/[^\w.-]+/g, "_") || "lab"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => importLab(String(reader.result));
    reader.readAsText(file);
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#8b98a5]">Devices</h2>
        <div className="flex flex-col gap-1.5">
          {PALETTE.map((t) =>
            t === "switch" ? (
              <div key={t} className="flex flex-col gap-1">
                <PaletteItem type="switch" ports={switchPorts} />
                <div className="flex items-center gap-1 pl-1 text-[10px] text-[#8b98a5]">
                  ports:
                  {SWITCH_SIZES.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSwitchPorts(s)}
                      className={`rounded px-1 ${switchPorts === s ? "bg-accent-2/20 text-accent-2" : "hover:text-[#e6edf3]"}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <PaletteItem key={t} type={t} />
            ),
          )}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-[#5f6b7a]">
          Drag onto the canvas (or double-click). Drag between the colored port dots to connect cables.
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#8b98a5]">Lab</h2>
        <div className="flex flex-col gap-1.5">
          <button onClick={loadSample} className="btn-primary">
            Load sample lab
          </button>
          <button onClick={newLab} className="btn">
            New / clear
          </button>
          <button onClick={onExport} className="btn">
            Export JSON
          </button>
          <button onClick={() => fileRef.current?.click()} className="btn">
            Import JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])}
          />
        </div>
      </div>

      <div className="border-t border-edge pt-3">
        <SonicFeaturePanel />
      </div>

      <div className="rounded-md border border-edge bg-panel-2 p-2.5 text-[11px] leading-relaxed text-[#8b98a5]">
        <div className="mb-1 font-semibold text-[#e6edf3]">Quick start</div>
        <ol className="list-decimal space-y-0.5 pl-4">
          <li>Load the sample lab</li>
          <li>Click PC1, open its terminal</li>
          <li>
            Run <code className="text-accent-2">ping 192.168.100.101</code>
          </li>
          <li>Watch the packet timeline &amp; inspect frames</li>
        </ol>
      </div>
    </div>
  );
}
