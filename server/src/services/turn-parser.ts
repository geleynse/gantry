export interface ToolCallData {
  sequenceNumber: number;
  toolName: string;
  argsJson: string;
  resultSummary: string;
  success: boolean;
}

export interface TurnSummary {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  iterations: number;
  durationMs: number;
  model: string | null;
}

export interface GameState {
  credits: number;
  fuel: number | null;
  fuelMax: number | null;
  cargoUsed: number | null;
  cargoMax: number | null;
  system: string | null;
  poi: string | null;
  docked: boolean | null;
  homeSystem: string | null;
  homePoi: string | null;
  hull: number | null;
  hullMax: number | null;
  shield: number | null;
  shieldMax: number | null;
  shipName: string | null;
  shipClass: string | null;
  factionName?: string | null;
  factionTag?: string | null;
  factionStorageUsed?: number | null;
  factionStorageMax?: number | null;
}

export interface CombatEvent {
  eventType: 'pirate_combat' | 'pirate_warning' | 'player_died';
  pirateName: string | null;
  pirateTier: string | null;
  damage: number | null;
  hullAfter: number | null;
  maxHull: number | null;
  died: boolean;
  insurancePayout: number | null;
  system: string | null;
}

export interface ParsedTurn {
  toolCalls: ToolCallData[];
  summary: TurnSummary | null;
  gameState: GameState | null;
  combatEvents: CombatEvent[];
}

const OPENAI_PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gpt-5.4": { input: 2.50, cachedInput: 0.25, output: 15.00 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.50 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14.00 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14.00 },
  "gpt-5.1-codex-max": { input: 1.25, cachedInput: 0.125, output: 10.00 },
  "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10.00 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10.00 },
  "gpt-5.1-codex-mini": { input: 0.25, cachedInput: 0.025, output: 2.00 },
  "gpt-5-codex-mini": { input: 0.25, cachedInput: 0.025, output: 2.00 },
};

function estimateOpenAiCost(model: string | null, inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
  const rates = OPENAI_PRICING[(model ?? "").toLowerCase()] ?? OPENAI_PRICING["gpt-5.3-codex"];
  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens);
  return (
    (uncachedInputTokens / 1_000_000) * rates.input +
    (cacheReadTokens / 1_000_000) * rates.cachedInput +
    (outputTokens / 1_000_000) * rates.output
  );
}

interface PendingToolUse {
  name: string;
  action: string | null;
  argsJson: string;
}

interface PartialGameState {
  credits?: number;
  fuel?: number;
  fuelMax?: number;
  cargoUsed?: number;
  cargoMax?: number;
  system?: string;
  poi?: string;
  docked?: boolean;
  homeSystem?: string;
  homePoi?: string;
}

function extractCredits(content: string): number | null {
  try {
    const data = JSON.parse(content);
    if (typeof data?.credits === 'number') return data.credits;
    // Some responses wrap in a result field
    if (typeof data?.result?.credits === 'number') return data.result.credits;
  } catch { /* ignore */ }
  return null;
}

function extractLocation(content: string): Pick<PartialGameState, 'system' | 'poi' | 'docked' | 'homeSystem' | 'homePoi'> | null {
  try {
    const data = JSON.parse(content);
    const src = data?.location ?? data;
    const system = typeof src?.system === 'string' ? src.system : null;
    const poi = typeof src?.poi === 'string' ? src.poi : null;
    const docked = typeof src?.docked === 'boolean' ? src.docked : null;
    
    const homeSystem = typeof data?.home_system === 'string' ? data.home_system : null;
    const homePoi = typeof data?.home_poi === 'string' ? data.home_poi : null;

    if (system || homeSystem) {
      return { 
        system: system ?? undefined, 
        poi: poi ?? undefined, 
        docked: docked ?? undefined,
        homeSystem: homeSystem ?? undefined,
        homePoi: homePoi ?? undefined
      };
    }
  } catch { /* ignore */ }
  return null;
}

function extractFuel(content: string): Pick<PartialGameState, 'fuel' | 'fuelMax'> | null {
  try {
    const data = JSON.parse(content);
    const src = data?.fuel ?? data;
    const fuel = typeof src?.current === 'number' ? src.current : (typeof data?.fuel === 'number' ? data.fuel : null);
    const fuelMax = typeof src?.max === 'number' ? src.max : (typeof data?.fuelMax === 'number' ? data.fuelMax : null);
    if (fuel !== null) return { fuel, fuelMax: fuelMax ?? undefined };
  } catch { /* ignore */ }
  return null;
}

function extractCargo(content: string): Pick<PartialGameState, 'cargoUsed' | 'cargoMax'> | null {
  try {
    const data = JSON.parse(content);
    const src = data?.cargo ?? data;
    const cargoUsed = typeof src?.used === 'number' ? src.used : (typeof data?.cargoUsed === 'number' ? data.cargoUsed : null);
    const cargoMax = typeof src?.max === 'number' ? src.max : (typeof data?.cargoMax === 'number' ? data.cargoMax : null);
    if (cargoUsed !== null) return { cargoUsed, cargoMax: cargoMax ?? undefined };
  } catch { /* ignore */ }
  return null;
}

function partialToGameState(partial: PartialGameState): GameState | null {
  if (partial.credits === undefined) return null;
  return {
    credits: partial.credits,
    fuel: partial.fuel ?? null,
    fuelMax: partial.fuelMax ?? null,
    cargoUsed: partial.cargoUsed ?? null,
    cargoMax: partial.cargoMax ?? null,
    system: partial.system ?? null,
    poi: partial.poi ?? null,
    docked: partial.docked ?? null,
    homeSystem: partial.homeSystem ?? null,
    homePoi: partial.homePoi ?? null,
    hull: null,
    hullMax: null,
    shield: null,
    shieldMax: null,
    shipName: null,
    shipClass: null,
  };
}

const MAX_FIELD_LEN = 500;

function truncate(s: string): string {
  // Extra null guard: Bun 1.x may pass undefined despite TypeScript types
  if (s == null || typeof s !== 'string') return '';
  return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) : s;
}

export function extractGameState(content: string): GameState | null {
  try {
    const data = JSON.parse(content);
    if (typeof data !== 'object' || data === null) return null;

    // Login responses nest player data under data.player — unwrap if present
    const src = (data.player && typeof data.player === 'object') ? { ...data, ...data.player } : data;

    // Extract credits
    const credits = typeof src.credits === 'number' ? src.credits : null;
    if (credits === null) return null;

    // Extract fuel — nested { current, max } or flat fuel/fuelMax
    let fuel: number;
    let fuelMax: number;
    if (typeof src.fuel === 'object' && src.fuel !== null) {
      fuel = src.fuel.current;
      fuelMax = src.fuel.max;
    } else {
      fuel = src.fuel;
      fuelMax = src.fuelMax;
    }

    // Extract cargo — nested { used, max } or flat cargoUsed/cargoMax
    let cargoUsed: number;
    let cargoMax: number;
    if (typeof src.cargo === 'object' && src.cargo !== null) {
      cargoUsed = src.cargo.used;
      cargoMax = src.cargo.max;
    } else {
      cargoUsed = src.cargoUsed;
      cargoMax = src.cargoMax;
    }

    // Extract location — nested { system, poi } or flat
    let system: string;
    let poi: string;
    if (typeof src.location === 'object' && src.location !== null) {
      system = src.location.system;
      poi = src.location.poi;
    } else {
      system = src.current_system ?? src.system;
      poi = src.current_poi ?? src.poi;
    }

    const docked = typeof src.docked === 'boolean' ? src.docked : false;

    const fuelVal = typeof fuel === 'number' ? fuel : null;
    const fuelMaxVal = typeof fuelMax === 'number' ? fuelMax : null;
    const cargoUsedVal = typeof cargoUsed === 'number' ? cargoUsed : null;
    const cargoMaxVal = typeof cargoMax === 'number' ? cargoMax : null;
    const systemVal = typeof system === 'string' ? system : null;
    const poiVal = typeof poi === 'string' ? poi : null;

    // Extract hull/shield/ship — optional fields, null if not present
    const hull = typeof src.hull === 'number' ? src.hull : null;
    const hullMax = typeof src.max_hull === 'number' ? src.max_hull : null;
    const shield = typeof src.shield === 'number' ? src.shield : null;
    const shieldMax = typeof src.max_shield === 'number' ? src.max_shield : null;
    const shipName = typeof src.ship_name === 'string' ? src.ship_name : null;
    const shipClass = typeof src.ship_class === 'string' ? src.ship_class : null;
    const homeSystem = typeof src.home_system === 'string' ? src.home_system : null;
    const homePoi = typeof src.home_poi === 'string' ? src.home_poi : null;

    // Faction info
    const factionName = typeof src.faction?.name === 'string' ? src.faction.name : (typeof src.faction_name === 'string' ? src.faction_name : null);
    const factionTag = typeof src.faction?.tag === 'string' ? src.faction.tag : (typeof src.faction_tag === 'string' ? src.faction_tag : null);
    const factionStorageUsed = typeof src.faction?.storage_used === 'number' ? src.faction.storage_used : null;
    const factionStorageMax = typeof src.faction?.storage_capacity === 'number' ? src.faction.storage_capacity : null;

    return { credits, fuel: fuelVal, fuelMax: fuelMaxVal, cargoUsed: cargoUsedVal, cargoMax: cargoMaxVal, system: systemVal, poi: poiVal, docked, homeSystem, homePoi, hull, hullMax, shield, shieldMax, shipName, shipClass, factionName, factionTag, factionStorageUsed, factionStorageMax };
  } catch {
    return null;
  }
}

/**
 * Extract combat events from a YAML tool result string.
 * Events are embedded in the `events:` section of YAML-formatted tool results.
 */
export function extractCombatEvents(yamlText: string, system?: string | null): CombatEvent[] {
  const events: CombatEvent[] = [];
  if (!yamlText || !yamlText.includes('events:')) return events;

  // Parse the events section manually to avoid pulling in a YAML dep at parse time
  // (yaml is available in package.json but we parse simply here)
  const lines = yamlText.split('\n');
  let inEvents = false;
  let currentEventType: string | null = null;
  let currentData: Record<string, string | number | boolean> = {};
  let inData = false;

  const finalizeEvent = () => {
    if (!currentEventType) return;
    if (currentEventType === 'pirate_combat') {
      events.push({
        eventType: 'pirate_combat',
        pirateName: typeof currentData.pirate_name === 'string' ? currentData.pirate_name : null,
        pirateTier: typeof currentData.pirate_tier === 'string' ? currentData.pirate_tier : null,
        damage: typeof currentData.damage === 'number' ? currentData.damage : null,
        hullAfter: typeof currentData.your_hull === 'number' ? currentData.your_hull : null,
        maxHull: typeof currentData.your_max_hull === 'number' ? currentData.your_max_hull : null,
        died: false,
        insurancePayout: null,
        system: system ?? null,
      });
    } else if (currentEventType === 'pirate_warning') {
      events.push({
        eventType: 'pirate_warning',
        pirateName: typeof currentData.pirate_name === 'string' ? currentData.pirate_name : null,
        pirateTier: typeof currentData.pirate_tier === 'string' ? currentData.pirate_tier : null,
        damage: null,
        hullAfter: null,
        maxHull: null,
        died: false,
        insurancePayout: null,
        system: system ?? null,
      });
    } else if (currentEventType === 'player_died') {
      events.push({
        eventType: 'player_died',
        pirateName: null,
        pirateTier: null,
        damage: null,
        hullAfter: null,
        maxHull: null,
        died: true,
        insurancePayout: typeof currentData.insurance_payout === 'number' ? currentData.insurance_payout : null,
        system: system ?? null,
      });
    }
    currentEventType = null;
    currentData = {};
    inData = false;
  };

  for (const line of lines) {
    if (!inEvents) {
      if (line.trim() === 'events:') { inEvents = true; }
      continue;
    }
    // Stop at any top-level key that isn't events content
    if (line.match(/^[a-z_]+:/i) && !line.match(/^\s/)) {
      finalizeEvent();
      break;
    }
    // New event item: "  - type: pirate_combat"
    const typeMatch = line.match(/^\s+-\s+type:\s+(\S+)/);
    if (typeMatch) {
      finalizeEvent();
      currentEventType = typeMatch[1];
      inData = false;
      continue;
    }
    // "    data:" marker
    if (line.match(/^\s+data:/)) {
      inData = true;
      continue;
    }
    // Data field: "      damage: 15"
    if (inData && currentEventType) {
      const fieldMatch = line.match(/^\s+(\w+):\s+(.+)/);
      if (fieldMatch) {
        const key = fieldMatch[1];
        const raw = fieldMatch[2].trim();
        const numVal = Number(raw);
        currentData[key] = isNaN(numVal) ? raw : numVal;
      }
    }
  }
  finalizeEvent();
  return events;
}

export function parseTurnFile(content: string): ParsedTurn {
  const result: ParsedTurn = {
    toolCalls: [],
    summary: null,
    gameState: null,
    combatEvents: [],
  };

  if (!content.trim()) return result;

  const pending = new Map<string, PendingToolUse>();
  let sequence = 0;
  const partial: PartialGameState = {};
  // Best-known system at the current point in the turn log. Updated inline as
  // get_status and get_location results are processed so that combat events
  // that appear before (or alongside) those calls can still be attributed to
  // the correct system on a best-effort basis.
  let currentSystem: string | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    type ContentBlock = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; [key: string]: unknown };
    type LogEntry = {
      type?: string;
      message?: { content?: ContentBlock[] };
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cached_input_tokens?: number };
      num_turns?: number;
      duration_ms?: number;
      model?: string;
      [key: string]: unknown;
    };
    let entry: LogEntry;
    try {
      entry = JSON.parse(trimmed) as LogEntry;
    } catch {
      continue;
    }

    if (entry.type === 'assistant' && entry.message?.content) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_use' && block.id) {
          // For v2 action-dispatch tools (mcp__spacemolt__spacemolt etc.),
          // extract the action name so state extraction can match on it
          const rawName = block.name ?? '';
          const input = block.input as Record<string, unknown> | undefined;
          const action = typeof input?.action === 'string' ? input.action : null;
          pending.set(block.id, {
            name: rawName,
            action,
            argsJson: truncate(JSON.stringify(input ?? {})),
          });
        }
      }
    } else if (entry.type === 'user' && entry.message?.content) {
      // tool_result blocks come in user messages
      const contentBlocks = Array.isArray(entry.message.content)
        ? entry.message.content
        : [];

      for (const block of contentBlocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const pendingTool = pending.get(block.tool_use_id);
          if (pendingTool) {
            // Extract text from content — handle string, array [{type,text}], or null
            const rawContent = block.content;
            let contentStr: string;
            if (typeof rawContent === 'string') {
              contentStr = rawContent;
            } else if (rawContent == null) {
              contentStr = '';
            } else if (Array.isArray(rawContent)) {
              // New Claude Code format: [{type:"text", text:"..."}]
              // Extract the actual text so game state / combat extraction works correctly
              contentStr = rawContent
                .filter((c: unknown) => c != null && typeof (c as {type:unknown}).type === 'string' && (c as {type:string}).type === 'text')
                .map((c: unknown) => (c as {text:unknown}).text ?? '')
                .filter((t: unknown) => typeof t === 'string')
                .join('\n');
            } else {
              try {
                contentStr = JSON.stringify(rawContent) ?? '';
              } catch {
                contentStr = '';
              }
            }

            const toolCall: ToolCallData = {
              sequenceNumber: sequence++,
              toolName: pendingTool.name,
              argsJson: pendingTool.argsJson,
              resultSummary: truncate(contentStr),
              success: !block.is_error,
            };
            result.toolCalls.push(toolCall);

            // For v2 action dispatch, match on the action param; for v1/direct, match on tool name
            const matchName = pendingTool.action ?? pendingTool.name;

            // Try to extract game state from get_status and login results
            if (matchName.includes('get_status') || matchName.includes('login')) {
              const gs = extractGameState(contentStr);
              if (gs) {
                result.gameState = gs;
                if (gs.system) currentSystem = gs.system;
              }
            }
            // Accumulate partial state from individual tool calls
            if (matchName.includes('get_credits')) {
              const credits = extractCredits(contentStr);
              if (credits !== null) partial.credits = credits;
            } else if (matchName.includes('get_location')) {
              const loc = extractLocation(contentStr);
              if (loc) {
                Object.assign(partial, loc);
                if (loc.system) currentSystem = loc.system;
              }
            } else if (matchName.includes('get_fuel')) {
              const fuel = extractFuel(contentStr);
              if (fuel) Object.assign(partial, fuel);
            } else if (matchName.includes('get_cargo')) {
              const cargo = extractCargo(contentStr);
              if (cargo) Object.assign(partial, cargo);
            }

            // Extract _current_system injected by the proxy (see injection-registry.ts
            // "location-context" injection). Present in every tool response when the
            // agent's location is known from statusCache. Supports JSON and YAML formats.
            // Only used when currentSystem wasn't already set by get_status/get_location.
            if (!currentSystem) {
              try {
                const d = JSON.parse(contentStr) as Record<string, unknown>;
                const sys =
                  (typeof d._current_system === "string" ? d._current_system : null) ??
                  (typeof d.system === "string" ? d.system : null) ??
                  (typeof d.current_system === "string" ? d.current_system : null) ??
                  (typeof (d.location as Record<string, unknown> | undefined)?.system === "string"
                    ? (d.location as Record<string, unknown>).system as string
                    : null) ??
                  (typeof (d.location_after as Record<string, unknown> | undefined)?.system === "string"
                    ? (d.location_after as Record<string, unknown>).system as string
                    : null);
                if (sys) currentSystem = sys;
              } catch {
                // YAML response — look for _current_system: <value> injected by proxy
                const m = contentStr.match(/^_current_system:\s*(.+)$/m);
                if (m?.[1]?.trim()) currentSystem = m[1].trim();
              }
            }

            // Extract combat events from any tool result.
            // State extraction runs first above so that a get_status result that
            // also contains events (common in the game's YAML format) has its
            // system field available via currentSystem before event extraction.
            const combatEvts = extractCombatEvents(contentStr, currentSystem);
            if (combatEvts.length > 0) result.combatEvents.push(...combatEvts);

            pending.delete(block.tool_use_id ?? '');
          }
        }
      }
    } else if (entry.type === 'turn.completed' && entry.usage) {
      const u = entry.usage as Record<string, unknown>;
      const inputTokens = (u.input_tokens as number | undefined) ?? 0;
      const outputTokens = (u.output_tokens as number | undefined) ?? 0;
      const cacheReadTokens = (u.cached_input_tokens as number | undefined) ?? 0;
      const cacheCreateTokens = (u.cache_creation_input_tokens as number | undefined) ?? 0;
      const model = (entry.model as string | undefined) ?? result.summary?.model ?? null;
      const durationMs = (entry.duration_ms as number | undefined) ?? 0;
      const costUsd = estimateOpenAiCost(model, inputTokens, outputTokens, cacheReadTokens);

      if (costUsd > 0 || !result.summary) {
        result.summary = {
          costUsd,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreateTokens,
          iterations: 1,
          durationMs,
          model,
        };
      }
    } else if (entry.type === 'result') {
      // Two result formats exist:
      // 1. Claude CLI native: { total_cost_usd, usage: { input_tokens, output_tokens, ... }, num_turns, duration_ms, model }
      // 2. Fleet-cli compact:  { usage: { cost, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, durationMs, numTurns } }
      // Both may appear in the same file — prefer the one with actual cost data.
      const u = entry.usage as Record<string, unknown> | undefined;
      const costUsd = (entry.total_cost_usd as number | undefined) ?? (u?.cost as number | undefined) ?? 0;
      const inputTokens = (u?.input_tokens as number | undefined) ?? (u?.inputTokens as number | undefined) ?? 0;
      const outputTokens = (u?.output_tokens as number | undefined) ?? (u?.outputTokens as number | undefined) ?? 0;
      const cacheReadTokens = (u?.cache_read_input_tokens as number | undefined) ?? (u?.cacheReadTokens as number | undefined) ?? 0;
      const cacheCreateTokens = (u?.cache_creation_input_tokens as number | undefined) ?? (u?.cacheCreateTokens as number | undefined) ?? 0;
      const iterations = (entry.num_turns as number | undefined) ?? (u?.numTurns as number | undefined) ?? 0;
      const durationMs = (entry.duration_ms as number | undefined) ?? (u?.durationMs as number | undefined) ?? 0;

      // Only overwrite if this result line has cost data, or we don't have a summary yet
      if (costUsd > 0 || !result.summary) {
        result.summary = {
          costUsd,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreateTokens,
          iterations,
          durationMs,
          model: (entry.model as string | undefined) ?? result.summary?.model ?? null,
        };
      }
    }
  }

  // If no full get_status game state, fall back to partial state from individual tool calls
  if (!result.gameState && partial.credits !== undefined) {
    result.gameState = partialToGameState(partial);
  }

  // Backfill system on combat events that had no system at extraction time.
  // This handles turns where the combat event appeared before any get_status /
  // get_location call, but the system became known later in the same turn.
  const finalSystem = result.gameState?.system ?? partial.system ?? null;
  if (finalSystem) {
    for (const evt of result.combatEvents) {
      if (!evt.system) evt.system = finalSystem;
    }
  }

  return result;
}
