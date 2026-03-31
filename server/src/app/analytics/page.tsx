"use client";

import { useState } from "react";
import {
  CostChart,
  ToolUsageChart,
  AgentComparisonTable,
  ExpensiveTurnsTable,
  TokenEfficiencyPanel,
  EconomyPnlPanel,
  ModelCostComparison,
  SessionPnlPanel,
  SessionCreditChart,
} from "@/components/analytics-charts";

interface DateRangeOption {
  label: string;
  hours: number;
}

const DATE_RANGE_OPTIONS: DateRangeOption[] = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 7 * 24 },
  { label: "30d", hours: 30 * 24 },
  { label: "All", hours: 0 },
];

export default function AnalyticsPage() {
  const [selectedHours, setSelectedHours] = useState(24);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-primary/20 pb-4">
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider mb-4">
          Analytics
        </h1>

        {/* Date range selector */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            Time Range:
          </span>
          <div className="flex gap-1">
            {DATE_RANGE_OPTIONS.map((option) => (
              <button
                key={option.hours}
                onClick={() => setSelectedHours(option.hours)}
                className={`px-3 py-1.5 text-xs font-medium  transition-colors ${
                  selectedHours === option.hours
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-foreground hover:bg-secondary/80"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Grid layout */}
      <div className="space-y-6">
        {/* Row 1: Cost over time (full width) */}
        <div className="bg-card border border-border p-4 ">
          <h2 className="text-sm font-semibold text-primary mb-4 uppercase tracking-wider">
            Cost Over Time
          </h2>
          <CostChart hours={selectedHours} />
        </div>

        {/* Row 1b: Session credits over time — from session handoffs, always available */}
        <div className="bg-card border border-border p-4">
          <h2 className="text-sm font-semibold text-primary mb-1 uppercase tracking-wider">
            Session Credits (P&amp;L per Session)
          </h2>
          <p className="text-[10px] text-muted-foreground mb-4">
            Credits gained/lost per session — independent of turn data
          </p>
          <SessionCreditChart />
        </div>

        {/* Row 2: Tool usage (left) + Agent comparison (right) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Tool Usage Chart */}
          <div className="bg-card border border-border p-4 ">
            <h2 className="text-sm font-semibold text-primary mb-4 uppercase tracking-wider">
              Tool Usage (Top 20)
            </h2>
            <ToolUsageChart hours={selectedHours} />
          </div>

          {/* Agent Comparison Table */}
          <div className="bg-card border border-border p-4 ">
            <h2 className="text-sm font-semibold text-primary mb-4 uppercase tracking-wider">
              Agent Comparison
            </h2>
            <AgentComparisonTable hours={selectedHours} />
          </div>
        </div>
        {/* Row 3: Economy P&L (left) + Model Cost Comparison (right) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-card border border-border p-4">
            <h2 className="text-sm font-semibold text-primary mb-4 uppercase tracking-wider">
              Economy P&L
            </h2>
            <EconomyPnlPanel hours={selectedHours} />
          </div>
          <div className="bg-card border border-border p-4">
            <h2 className="text-sm font-semibold text-primary mb-4 uppercase tracking-wider">
              Model Cost Comparison
            </h2>
            <ModelCostComparison hours={selectedHours} />
          </div>
        </div>

        {/* Row 4: Session P&L (full width) */}
        <div className="bg-card border border-border p-4">
          <h2 className="text-sm font-semibold text-primary mb-4 uppercase tracking-wider">
            Session P&amp;L
          </h2>
          <SessionPnlPanel />
        </div>

        {/* Row 5: Most expensive turns (full width) */}
        <div className="bg-card border border-border p-4">
          <h2 className="text-sm font-semibold text-primary mb-4 uppercase tracking-wider">
            Most Expensive Turns
          </h2>
          <ExpensiveTurnsTable hours={selectedHours} limit={10} />
        </div>

        {/* Row 4: Token efficiency (full width) */}
        <div className="bg-card border border-border p-4">
          <h2 className="text-sm font-semibold text-primary mb-4 uppercase tracking-wider">
            Token Efficiency
          </h2>
          <TokenEfficiencyPanel hours={selectedHours} />
        </div>
      </div>
    </div>
  );
}
