"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ConnectionMode,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import { useLabStore } from "@/lib/store/lab-store";
import { DeviceType } from "@/lib/models/device";
import { connectionFor } from "@/lib/models/topology";
import { DeviceNode } from "./DeviceNode";

const nodeTypes = { device: DeviceNode };

function CanvasInner() {
  const network = useLabStore((s) => s.network);
  const selectedDeviceId = useLabStore((s) => s.selectedDeviceId);
  const events = useLabStore((s) => s.events);
  const playbackIndex = useLabStore((s) => s.playback.index);
  const addDevice = useLabStore((s) => s.addDevice);
  const moveDevice = useLabStore((s) => s.moveDevice);
  const connect = useLabStore((s) => s.connect);
  const disconnect = useLabStore((s) => s.disconnect);
  const removeDevice = useLabStore((s) => s.removeDevice);
  const selectDevice = useLabStore((s) => s.selectDevice);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  // The event currently "reached" by playback drives highlighting.
  const { activeEdgeId, activeDeviceId } = useMemo(() => {
    const current = events[playbackIndex - 1];
    if (!current) return { activeEdgeId: undefined, activeDeviceId: undefined };
    let edgeId: string | undefined;
    if (current.link) {
      const conn = connectionFor(network, current.link.fromDeviceId, current.link.fromInterfaceId);
      edgeId = conn?.id;
    }
    return { activeEdgeId: edgeId, activeDeviceId: current.deviceId };
  }, [events, playbackIndex, network]);

  // Sync nodes from the store.
  useEffect(() => {
    setNodes(
      Object.values(network.devices).map((d) => ({
        id: d.id,
        type: "device",
        position: d.ui,
        data: { device: d },
        selected: d.id === selectedDeviceId,
        style:
          d.id === activeDeviceId
            ? { filter: "drop-shadow(0 0 10px rgba(34,211,238,0.9))" }
            : undefined,
      })),
    );
  }, [network, selectedDeviceId, activeDeviceId, setNodes]);

  // Sync edges from the store.
  useEffect(() => {
    setEdges(
      network.connections.map((c) => {
        const up = c.state === "up";
        return {
          id: c.id,
          source: c.a.deviceId,
          sourceHandle: c.a.interfaceId,
          target: c.b.deviceId,
          targetHandle: c.b.interfaceId,
          className: c.id === activeEdgeId ? "active-edge" : undefined,
          animated: c.id === activeEdgeId,
          style: { stroke: up ? "#64748b" : "#7f1d1d", strokeDasharray: up ? undefined : "6 4" },
        } satisfies Edge;
      }),
    );
  }, [network, activeEdgeId, setEdges]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3200);
  }, []);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      const res = connect(c.source, c.sourceHandle, c.target, c.targetHandle);
      if (!res.ok) flash(res.error ?? "Invalid connection");
    },
    [connect, flash],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/device-type") as DeviceType;
      if (!type) return;
      const portsRaw = e.dataTransfer.getData("application/device-ports");
      const ports = portsRaw ? Number(portsRaw) : undefined;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addDevice(type, position, ports);
    },
    [addDevice, screenToFlowPosition],
  );

  return (
    <div className="relative h-full w-full" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        onConnect={onConnect}
        onNodeClick={(_, node) => selectDevice(node.id)}
        onNodeDragStop={(_, node) => moveDevice(node.id, node.position.x, node.position.y)}
        onNodesDelete={(deleted) => deleted.forEach((n) => removeDevice(n.id))}
        onEdgesDelete={(deleted) => deleted.forEach((edge) => disconnect(edge.id))}
        onPaneClick={() => selectDevice(undefined)}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1c2230" />
        <Controls className="!bg-[#161b22] !border-[#2a3242]" />
        <MiniMap
          pannable
          zoomable
          nodeColor="#22d3ee"
          maskColor="rgba(11,14,20,0.7)"
          className="!bg-[#0b0e14]"
        />
      </ReactFlow>

      {Object.keys(network.devices).length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-lg border border-dashed border-[#2a3242] bg-[#0f1419]/70 px-6 py-4 text-center text-sm text-[#8b98a5]">
            Drag a device from the left, or click <span className="text-accent-2">Load sample lab</span>.
          </div>
        </div>
      )}

      {notice && (
        <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-md border border-danger/50 bg-[#2a1215] px-4 py-2 text-sm text-red-200 shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}

export function TopologyCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
