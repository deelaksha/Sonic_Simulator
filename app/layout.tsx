import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Networking Lab — learn networking by building it",
  description:
    "Interactive networking learning platform: build topologies, run Linux commands, watch real simulated packets move layer by layer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-mono">{children}</body>
    </html>
  );
}
