import type { Metadata } from "next";
import { AgentDetailClient } from "./client";

// NOTE: Next.js static export (output: "export") requires generateStaticParams to list
// all valid route segments at build time. We keep these hardcoded here because the
// static exporter can't call the API at build time. If you add agents to fleet-config,
// rebuild the frontend so their detail pages are included in the static output.
const STATIC_AGENT_NAMES = [
  "overseer",
  // Agent pages are generated at runtime from fleet config.
  // Add agent names here only if you need static pre-rendering.
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
