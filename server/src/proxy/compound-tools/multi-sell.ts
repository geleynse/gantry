/**
 * compound-tools/multi-sell.ts
 *
 * Implementation of the multi_sell compound tool.
 * Sells multiple items with market prerequisite enforcement and fleet deconfliction.
 */

import { createLogger } from "../../lib/logger.js";
import { getItemDisplayName } from "../../lib/utils.js";
import type { SellEntry } from "../sell-log.js";
import type { CompoundToolDeps, CompoundResult, MultiSellItem } from "./types.js";
import { stripPendingFields, refreshStatusOrFlag } from "./utils.js";
import { parseGetStatusText } from "../http-game-client-v2.js";

const log = createLogger("compound-tools");

/**
 * Check that analyze_market was called before selling. This enforces the prerequisite
 * at the compound tool level; callers must pass the set of called tools.
 */
export async function multiSell(
  deps: CompoundToolDeps,
  items: MultiSellItem[],
  calledTools: Set<string>,
): Promise<CompoundResult> {
  const { client, agentName, statusCache, sellLog } = deps;
  const isV2 = typeof client.isV2 === "function" && client.isV2();

  // Fetch fresh status to avoid stale cache (e.g. agent just docked but cache hasn't updated)
  let cachedStatus = statusCache.get(agentName);
  let playerData = cachedStatus?.data?.player as
    | Record<string, unknown>
    | undefined;

  // Prerequisite 1: Must be docked — if cache says not docked, refresh before blocking
  if (!playerData?.docked_at_base) {
    log.debug("multi_sell: cache says not docked, fetching fresh status", { agent: agentName });
    const freshStatus = isV2
      ? await client.execute("spacemolt", { action: "get_status" })
      : await client.execute("get_status", {});
    if (!freshStatus.error && freshStatus.result) {
      // The get_status text dashboard carries "Docked at: <station>" directly.
      // Read it here so a single get_status call settles dock state — avoids the
      // extra waitForTick→refreshStatus get_location round-trip (3 game calls →
      // 1), whose rate-limit failures were false-blocking legit sells.
      const parsedStatus = typeof freshStatus.result === "string"
        ? parseGetStatusText(freshStatus.result)
        : undefined;
      if (parsedStatus?.dockedAt) {
        // Harvest the fresh data we already paid for (credits + cargo) rather than
        // trusting the known-stale cache that sent us here. NOTE: do NOT set
        // current_poi from dockedAt — dockedAt is the BASE/station id, current_poi
        // is the POI id (different identifiers); overwriting it would split the
        // sellLog station-keying. Preserve the prior current_poi.
        const prevShip = (cachedStatus?.data?.ship as Record<string, unknown> | undefined) ?? {};
        playerData = {
          ...(playerData ?? {}),
          docked_at_base: parsedStatus.dockedAt,
          ...(parsedStatus.credits !== undefined ? { credits: parsedStatus.credits } : {}),
        };
        cachedStatus = {
          data: {
            ...(cachedStatus?.data ?? {}),
            player: playerData,
            ship: {
              ...prevShip,
              ...(parsedStatus.cargoUsed !== undefined ? { cargo_used: parsedStatus.cargoUsed } : {}),
              // cargo as [{name, quantity}] — the ALL-resolution map keys by item_id
              // or name-slug, so this fresh name-keyed cargo works there.
              ...(parsedStatus.cargo.length > 0 ? { cargo: parsedStatus.cargo } : {}),
            },
          },
          fetchedAt: Date.now(),
        };
      } else {
        // Text was inconclusive (non-string, or no "Docked at:" line) — fall back
        // to the full refresh (get_status + get_location) via waitForTick.
        await client.waitForTick();
        cachedStatus = statusCache.get(agentName);
        playerData = cachedStatus?.data?.player as Record<string, unknown> | undefined;
      }
    }
  }

  if (!playerData?.docked_at_base) {
    log.warn("multi_sell blocked: not docked (confirmed after refresh)", { agent: agentName });
    return {
      error: "You must be docked at a station to use multi_sell. (Verified with fresh get_status — you are not docked.)",
    };
  }

  // Prerequisite 2: Enforce analyze_market — check session calls OR recent cache timestamp
  // Agents must check demand before selling. Session calls are reset on login,
  // so we also check a 20-minute lookback in the status cache.
  const lastMarketAt = (cachedStatus?.data as any)?._last_market_analysis_at as number | undefined;
  const recentMarket = lastMarketAt && (Date.now() - lastMarketAt < 20 * 60_000);

  // Advisory: warn if no recent market check, but don't block the sell
  const hasMarketCheck = calledTools.has("analyze_market") || calledTools.has("view_market");
  let marketWarning: string | undefined;
  if (!hasMarketCheck && !recentMarket) {
    log.info("multi_sell proceeding without recent market check", {
      agent: agentName,
      cache_age_ms: lastMarketAt ? Date.now() - lastMarketAt : "none"
    });
    marketWarning = "⚠️ No recent analyze_market — selling without checking demand may earn 0 credits. Call analyze_market() before selling next time.";
  }

  // Check for recent fleet sells at this station
  const currentStation = playerData.current_poi as string | undefined;
  let fleetSellWarning: string | undefined;

  if (currentStation) {
    const itemIds = items.map((i) => i.item_id);
    const overlaps = sellLog.findOverlaps(currentStation, itemIds, agentName);
    if (overlaps.length > 0) {
      const warnings = overlaps.map((o: SellEntry) => {
        const agoMin = Math.round((Date.now() - o.timestamp) / 60_000);
        return `${o.agent} sold ${o.item_id} (×${o.quantity}) here ${agoMin} min ago`;
      });
      fleetSellWarning = `Recent fleet activity at this station: ${warnings.join("; ")}. Demand may be reduced.`;
      log.debug("multi_sell fleet overlap detected", {
        agent: agentName,
        overlaps: overlaps.length,
      });
    }
  }

  // Capture credits and cargo before selling for delta tracking
  const creditsBefore = playerData?.credits as number | undefined;
  const cargoUsedBefore = (cachedStatus?.data?.ship as any)?.cargo_used as number | undefined;

  log.info("multi_sell START", {
    agent: agentName,
    items_count: items.length,
    credits_before: creditsBefore ?? "unknown",
  });

  const results: { item_id: string; quantity: number; result: unknown }[] = [];

  // Execute sells sequentially. Tick waits are minimized to prevent HTTP response
  // timeouts — the MCP transport holds the connection open with enableJsonResponse:true,
  // so long-running multi_sell causes the client to time out and receive "".
  // Only a single final tick wait is used to let credits settle in cache.

  // Resolve "ALL" quantities from cargo cache before selling.
  // refreshStatus parses status-dashboard cargo as { name, quantity } (no
  // item_id), so key the map by item_id when present else by a name→id slug
  // (matches routine-utils.itemNameToId / the inverse of getItemDisplayName).
  // Without this, every entry collapsed to an `undefined` key and ALL/unspecified
  // quantities always failed with "No <item> in cargo to sell".
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const cargo = (cachedStatus?.data?.ship as any)?.cargo as Array<{ item_id?: string; name?: string; quantity: number }> | undefined;
  const cargoMap = new Map(
    cargo?.flatMap(c => {
      const key = c.item_id ?? (c.name ? slug(c.name) : undefined);
      return key ? [[key, c.quantity] as [string, number]] : [];
    }) ?? [],
  );

  // Status-dashboard cargo carries only { name, quantity }, so cargoMap keys are
  // effectively always name-slugs — but agents pass CANONICAL game ids, which can
  // differ from the name slug (mining_laser_1 vs "Mining Laser I" → mining_laser_i;
  // the known name-vs-item_id gotcha, see routine-utils itemNameToId). On a miss,
  // retry with derived aliases: the slug of the id, the slug of its display name
  // (covers ITEM_MAPPING), and a trailing arabic→roman tier conversion.
  const ROMAN_TIERS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
  const lookupCargoQty = (itemId: string): number | undefined => {
    const direct = cargoMap.get(itemId)
      ?? cargoMap.get(slug(itemId))
      ?? cargoMap.get(slug(getItemDisplayName(itemId)));
    if (direct !== undefined) return direct;
    const m = slug(itemId).match(/^(.*)_(\d+)$/);
    if (m) {
      const tier = Number(m[2]);
      if (tier >= 1 && tier <= ROMAN_TIERS.length) return cargoMap.get(`${m[1]}_${ROMAN_TIERS[tier - 1]}`);
    }
    return undefined;
  };

  for (let i = 0; i < items.length; i++) {
    const { item_id } = items[i];
    let { quantity } = items[i];
    // Resolve "ALL" or non-numeric quantities to actual cargo amount
    if (quantity === ("ALL" as any) || typeof quantity !== "number" || quantity <= 0) {
      const cargoQty = lookupCargoQty(item_id);
      if (cargoQty && cargoQty > 0) {
        quantity = cargoQty;
        log.debug("multi_sell resolved ALL quantity", { agent: agentName, item_id, quantity });
      } else {
        results.push({ item_id, quantity: 0, result: { error: `No ${item_id} in cargo to sell` } });
        continue;
      }
    }
    const resp = isV2
      ? await client.execute("spacemolt", { action: "sell", item_id, quantity }, { noRetry: true })
      : await client.execute("sell", { item_id, quantity }, { noRetry: true });

    if (resp.error) {
      // Wrap under an `error` key (same shape as the no-cargo entry above) —
      // the game client's error is { code, message } with no `error` key, and
      // both the sell-log filter below and items_sold counting key off it.
      results.push({ item_id, quantity, result: { error: resp.error } });
      log.warn("multi_sell item failed", {
        agent: agentName,
        item_index: i,
        item_id,
        quantity,
      });
    } else {
      stripPendingFields(resp.result);
      results.push({ item_id, quantity, result: resp.result });
      log.debug("multi_sell item completed", {
        agent: agentName,
        item_index: i,
        item_id,
        quantity,
      });
    }
  }

  // Refresh status after all sells — lets the game resolve pending sells
  // and update credits/cargo in cache. Use refreshStatusOrFlag so a -32029
  // rate-limit on the underlying get_status/get_location is detected: the
  // pre-action cache must NOT be reported as the post-sale state. Sales
  // settle server-side regardless of whether we can verify them; the agent
  // gets told the verification status, not a fabricated credits_delta=0.
  const refreshOutcome = await refreshStatusOrFlag(client, agentName, statusCache);

  // Get final credits from cache (may be stale if refresh failed; we flag that below)
  const cached = statusCache.get(agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const credits = player?.credits ?? "unknown";

  const creditDelta =
    typeof credits === "number" && typeof creditsBefore === "number"
      ? credits - creditsBefore
      : "unknown";
  log.info("multi_sell DONE", {
    agent: agentName,
    credits_after: credits,
    credits_delta: creditDelta,
    verification_updated: refreshOutcome.updated,
    verification_attempts: refreshOutcome.attempts,
  });

  // Normalize "Sold 0 for 0cr" cosmetic display — see sable-thorn 2026-06-01.
  // The game's sell readout sometimes shows "Sold 0 for 0cr" even when credits
  // DID transfer. Annotate each affected item with the real outcome so agents
  // don't retry-loop or abandon a successful sell based on the display string.
  //
  // Three cases:
  //   (a) credits_before unavailable → _cosmetic_display_unknown: true (no delta fabricated)
  //   (b) credits increased → _cosmetic_zero_cr: true + credits_delta (divided evenly across items)
  //   (c) credits unchanged → _sell_no_op: true + cause_hint (genuine no-op)
  //
  // Note: this runs BEFORE the rate-limited branch so we annotate items regardless;
  // the rate-limited branch may later suppress credits_after/credits_delta at the
  // top level, but per-item normalization is still useful context for the agent.
  const ZERO_CR_PATTERN = /^Sold 0(\s|$).*for 0\s*cr/i;
  const zeroCrItems = results.filter((r) => {
    if (r.result && typeof r.result === "object" && !Array.isArray(r.result)) {
      const msg = (r.result as Record<string, unknown>).message;
      if (typeof msg === "string" && ZERO_CR_PATTERN.test(msg)) return true;
    }
    return false;
  });

  if (zeroCrItems.length > 0) {
    if (creditsBefore === undefined) {
      // Case (a): can't compute real delta — flag ambiguity without fabricating
      for (const item of zeroCrItems) {
        (item.result as Record<string, unknown>)._cosmetic_display_unknown = true;
        log.info("multi_sell zero-cr display: credits_before unavailable, flagging ambiguity", {
          agent: agentName,
          item_id: item.item_id,
        });
      }
    } else if (typeof creditDelta === "number" && creditDelta > 0) {
      // Case (b): credits DID transfer — divide delta evenly among zero-cr items
      // (best approximation; can't split precisely without per-item game responses)
      const perItemDelta = Math.floor(creditDelta / zeroCrItems.length);
      for (const item of zeroCrItems) {
        (item.result as Record<string, unknown>)._cosmetic_zero_cr = true;
        (item.result as Record<string, unknown>).credits_delta = perItemDelta;
        log.info("multi_sell zero-cr display normalized: cosmetic lag, credits transferred", {
          agent: agentName,
          item_id: item.item_id,
          credits_delta: perItemDelta,
        });
      }
    } else if (typeof creditDelta === "number" && creditDelta === 0) {
      // Case (c): genuine no-op — no credits moved
      for (const item of zeroCrItems) {
        (item.result as Record<string, unknown>)._sell_no_op = true;
        (item.result as Record<string, unknown>).cause_hint =
          "Station has no demand for this item — 0 credits earned. " +
          "Travel to a station with buyers (use analyze_market to find one) or create a sell order.";
        log.info("multi_sell zero-cr display normalized: genuine no-op", {
          agent: agentName,
          item_id: item.item_id,
        });
      }
    }
    // Case: creditDelta === "unknown" — refresh failed (rate-limited path below handles it)
  }

  // Only count entries that actually sold — failed sells and "No <item> in
  // cargo" entries carry an `error` key in their result and must not inflate
  // items_sold (routines report "Sold N items" from this value verbatim).
  const successfulSells = results.filter(
    (r) => !(r.result && typeof r.result === "object" && "error" in (r.result as Record<string, unknown>)),
  );
  const sellResult: Record<string, unknown> = {
    status: "completed",
    sells: results,
    items_sold: successfulSells.length,
  };

  if (!refreshOutcome.updated && results.length > 0) {
    // Refresh hit a transport error (rate limit / network) on every attempt.
    // Cache is pre-sale stale. Do NOT lie about credits_delta=0 or "cargo unchanged" —
    // the sells may have settled server-side; we just can't see the result. Tell the
    // agent explicitly so they can call get_status / get_cargo to reconcile.
    log.warn("multi_sell verification failed (refreshStatus rate-limited or unavailable)", {
      agent: agentName,
      refresh_attempts: refreshOutcome.attempts,
      credits_before: creditsBefore,
      cargo_used_before: cargoUsedBefore,
    });
    sellResult.verification_status = "rate_limited";
    sellResult.verification_message =
      "Sells were dispatched to the game server, but post-sale verification was rate-limited. " +
      "Cargo and credit deltas could NOT be confirmed from the proxy cache (it is pre-sale stale). " +
      "Sales may have settled server-side. Call get_cargo() and get_status() in 5–10s to reconcile actual state. " +
      "Do NOT retry the same sells without verifying — they may already be complete.";
    sellResult.credits_before = creditsBefore;
    sellResult.cargo_used_before = cargoUsedBefore;
    // Intentionally omit credits_after / credits_delta / cargo_warning — emitting them with
    // stale values is exactly the lie this fix exists to prevent.
  } else {
    // Cache is fresh — safe to compute deltas and run desync verification.
    sellResult.credits_after = credits;
    sellResult.verification_status = "ok";

    // Verify cargo actually changed — catches silent no-ops where the game accepts the call
    // but doesn't actually remove items (e.g. session desync, station state issues).
    const cargoUsedAfter = (statusCache.get(agentName)?.data?.ship as any)?.cargo_used as number | undefined;
    const cargoReduced =
      cargoUsedAfter !== undefined && cargoUsedBefore !== undefined && cargoUsedAfter < cargoUsedBefore;
    const cargoDataAvailable = cargoUsedAfter !== undefined && cargoUsedBefore !== undefined;

    if (cargoDataAvailable && !cargoReduced && results.length > 0) {
      log.warn("multi_sell cargo unchanged after sells", {
        agent: agentName,
        cargo_used_before: cargoUsedBefore,
        cargo_used_after: cargoUsedAfter,
      });
      sellResult.cargo_warning =
        "WARNING: Cargo hold unchanged after sells — items may not have been removed. " +
        "This can happen when the game is desynced or items have already been sold/listed. " +
        "Call get_status to verify actual cargo, then retry if needed.";
    }

    // Warn agent if sells earned nothing — likely no station demand
    if (typeof creditDelta === "number" && creditDelta === 0 && results.length > 0) {
      sellResult.warning =
        "0 credits earned — this station has no demand for your items. " +
        "Items remain in your cargo (not auto-listed). " +
        "Travel to a different station with demand, or use analyze_market() to find buyers.";
    }
  }

  // Inject market check advisory if no recent analyze_market
  if (marketWarning) {
    sellResult._market_advisory = marketWarning;
  }

  // Record sells for fleet deconfliction
  if (currentStation) {
    for (const r of results) {
      if (
        !r.result ||
        (typeof r.result === "object" &&
          "error" in (r.result as Record<string, unknown>))
      )
        continue;
      sellLog.record(currentStation, {
        agent: agentName,
        item_id: r.item_id,
        quantity: r.quantity,
        timestamp: Date.now(),
      });
    }
  }

  if (fleetSellWarning) {
    sellResult.fleet_sell_warning = fleetSellWarning;
  }

  return sellResult;
}
