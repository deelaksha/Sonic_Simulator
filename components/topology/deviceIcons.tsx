import { DeviceType } from "@/lib/models/device";

interface DeviceVisual {
  icon: string;
  label: string;
  accent: string;
}

const VISUALS: Record<DeviceType, DeviceVisual> = {
  pc: { icon: "🖥️", label: "PC", accent: "#3b82f6" },
  server: { icon: "🗄️", label: "Server", accent: "#8b5cf6" },
  switch: { icon: "🔀", label: "Switch", accent: "#22d3ee" },
  router: { icon: "🧭", label: "Router", accent: "#a78bfa" },
  firewall: { icon: "🛡️", label: "Firewall", accent: "#ef4444" },
  internet: { icon: "🌐", label: "Internet", accent: "#22c55e" },
  "dns-server": { icon: "📇", label: "DNS", accent: "#f59e0b" },
  "dhcp-server": { icon: "📮", label: "DHCP", accent: "#f59e0b" },
  "ntp-server": { icon: "⏱️", label: "NTP", accent: "#f59e0b" },
};

export function deviceVisual(type: DeviceType): DeviceVisual {
  return VISUALS[type];
}
