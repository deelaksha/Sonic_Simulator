"use client";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { Device } from "@/lib/models/device";
import { deviceVisual } from "./deviceIcons";

export interface DeviceNodeData {
  device: Device;
  [key: string]: unknown;
}

function handleColor(operState: string, connected: boolean): string {
  if (operState === "up") return "#22c55e"; // link up
  if (connected) return "#f59e0b"; // cabled but down
  return "#475569"; // free port
}

export function DeviceNode({ data, selected }: NodeProps) {
  const device = (data as DeviceNodeData).device;
  const visual = deviceVisual(device.type);
  const primaryIp = device.interfaces.find((i) => i.ipv4.length)?.ipv4[0];
  // Management (eth0) + logical interfaces (SVI/Loopback/PortChannel) are not
  // cablable physical ports — no canvas handle.
  const ports = device.interfaces.filter((i) => !i.management && !i.logical);
  const n = ports.length;

  return (
    <div
      className="rounded-lg border px-3 py-2 text-center shadow-lg transition-colors"
      style={{
        minWidth: 128,
        background: selected ? "#1c2230" : "#161b22",
        borderColor: selected ? visual.accent : "#2a3242",
        boxShadow: selected ? `0 0 0 1px ${visual.accent}` : undefined,
      }}
    >
      <div className="text-2xl leading-none">{visual.icon}</div>
      <div className="mt-1 text-sm font-semibold text-[#e6edf3]">{device.name}</div>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: visual.accent }}>
        {visual.label}
      </div>
      {primaryIp && (
        <div className="mt-0.5 text-[10px] text-[#8b98a5]">
          {primaryIp.address}/{primaryIp.prefix}
        </div>
      )}

      {ports.map((iface, idx) => {
        const left = ((idx + 1) / (n + 1)) * 100;
        return (
          <Handle
            key={iface.id}
            id={iface.id}
            type="source"
            position={Position.Bottom}
            title={`${iface.name} (${iface.operState})`}
            style={{
              left: `${left}%`,
              background: handleColor(iface.operState, !!iface.connectedTo),
            }}
          />
        );
      })}
    </div>
  );
}
