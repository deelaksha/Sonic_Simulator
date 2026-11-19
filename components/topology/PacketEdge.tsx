"use client";
/** Topology cable that can carry the animated packet of the current hop (components/switch3d/packetPlayer). */
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { PacketHop } from "@/lib/switch3d/model";
import { PacketOnPath } from "@/components/switch3d/packetPlayer";

export type PacketEdgeData = { hop?: PacketHop; forward?: boolean; ms?: number; animKey?: string };

export function PacketEdge(props: EdgeProps<Edge<PacketEdgeData>>) {
  const [path] = getBezierPath(props);
  const d = props.data;
  return (
    <>
      <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} />
      {d?.hop && <PacketOnPath hop={d.hop} path={path} forward={!!d.forward} ms={d.ms ?? 650} animKey={d.animKey ?? d.hop.id} />}
    </>
  );
}
