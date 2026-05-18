import type { Metadata } from "next";
import { AgentDetailClient } from "./client";

// NOTE: Next.js static export (output: "export") requires generateStaticParams to list
// all valid route segments at build time. Keep this in sync with fleet-config.json.
// If agents are added or removed, rebuild the frontend so their detail pages are
// included (or excluded) from the static output.
const STATIC_AGENT_NAMES = [
  "drifter-gale",
  "sable-thorn",
  "rust-vane",
  "lumen-shoal",
  "cinder-wake",
  "brass-meridian",
  "hollow-pyre",
  "overseer",
];

export async function generateStaticParams(): Promise<Array<{ name: string }>> {
  return STATIC_AGENT_NAMES.map((name) => ({ name }));
}

export const dynamicParams = false;

export const metadata: Metadata = {
  title: "Agent Detail",
};

export default function AgentDetailPage() {
  return <AgentDetailClient />;
}
