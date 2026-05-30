/**
 * TaxMonitor — Watches empire info cache refreshes for policy transitions.
 *
 * On each cache refresh, compares previous and current per-empire state:
 *   - tax_collection_active false → true: fires a HIGH severity fleet alert
 *   - citizenship_open false → true: fires a MEDIUM severity fleet alert
 *
 * First refresh after server start: populates internal state without firing alerts
 * (prev is undefined, not false — so no transition detected on cold start).
 */

import { createAlert, hasRecentAlert } from "../services/alerts-db.js";
import { createLogger } from "../lib/logger.js";
import type { EmpireInfo } from "./empire-info-cache.js";

const log = createLogger("tax-monitor");

const TAX_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export class TaxMonitor {
  private previousTaxActive = new Map<string, boolean>();
  private previousCitizenshipOpen = new Map<string, boolean>();

  /**
   * Called on each empire info cache refresh.
   * Detects false→true transitions and fires fleet-wide alerts.
   *
   * Cold start: prev is undefined on first call, so no alerts fire.
   * Subsequent calls: only a transition from false→true fires an alert.
   */
  check(empires: EmpireInfo[]): void {
    for (const empire of empires) {
      this.checkTaxActivation(empire);
      this.checkCitizenshipOpened(empire);

      // Update state AFTER checks so next call sees the current values
      this.previousTaxActive.set(empire.id, empire.tax_collection_active);
      this.previousCitizenshipOpen.set(empire.id, empire.citizenship_open);
    }
  }

  private checkTaxActivation(empire: EmpireInfo): void {
    const prev = this.previousTaxActive.get(empire.id);
    const curr = empire.tax_collection_active;

    // Only fire on explicit false→true transition (not undefined→true on cold start)
    if (prev !== false || curr !== true) return;

    const category = `tax_active:${empire.id}`;
    if (hasRecentAlert("fleet", category, TAX_ALERT_WINDOW_MS)) {
      log.debug("tax activation alert suppressed (recent)", { empire: empire.id });
      return;
    }

    const incomePct = Math.round(empire.tax_rate_income * 100);
    const salesPct = Math.round(empire.tax_rate_sales * 100);
    const message =
      `TAX ACTIVATED in ${empire.name}: income tax (${incomePct}%), sales tax (${salesPct}%). ` +
      `Citizenship reduces rates — review strategy.`;

    createAlert("fleet", "high", category, message);
    log.warn("tax activation alert fired", { empire: empire.id, incomePct, salesPct });
  }

  private checkCitizenshipOpened(empire: EmpireInfo): void {
    const prev = this.previousCitizenshipOpen.get(empire.id);
    const curr = empire.citizenship_open;

    // Only fire on explicit false→true transition
    if (prev !== false || curr !== true) return;

    const category = `citizenship_open:${empire.id}`;
    if (hasRecentAlert("fleet", category, TAX_ALERT_WINDOW_MS)) {
      log.debug("citizenship alert suppressed (recent)", { empire: empire.id });
      return;
    }

    const reqs = empire.citizenship_requirements || "none listed";
    const message =
      `CITIZENSHIP OPEN in ${empire.name}: applications now accepted. ` +
      `Requirements: ${reqs}. Review agent citizenship strategy before applying.`;

    createAlert("fleet", "medium", category, message);
    log.warn("citizenship open alert fired", { empire: empire.id });
  }

  /** Reset internal state (for testing). */
  reset(): void {
    this.previousTaxActive.clear();
    this.previousCitizenshipOpen.clear();
  }
}
