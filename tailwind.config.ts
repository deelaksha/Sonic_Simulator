import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Dark network-tool palette (spec §51)
        panel: "#0f1419",
        "panel-2": "#161b22",
        "panel-3": "#1c2230",
        edge: "#2a3242",
        accent: "#3b82f6",
        "accent-2": "#22d3ee",
        ok: "#22c55e",
        warn: "#f59e0b",
        danger: "#ef4444",
        wireL1: "#94a3b8",
        wireL2: "#22d3ee",
        wireL3: "#a78bfa",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
