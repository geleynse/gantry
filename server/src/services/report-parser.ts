export interface ParsedOrder {
  type: string;
  message: string;
  target_agent: string | null;
  priority: "normal" | "urgent";
}

const COMBAT_ALERT_RE = /COMBAT ALERT:.*?(\d+)%.*?fighting\s+(\S+)\s+at\s+(\S+)/i;
const ORE_RE = /(?:found|discovered|rich)\s+(\w+)\s+(?:deposits?|ore)\s+at\s+(\S+)/i;
const TRADE_RE = /(?:high demand|good price|profitable)\s+(?:for\s+)?(\w+)\s+at\s+(\S+)/i;

export function parseReport(agentName: string, content: string): ParsedOrder[] {
  const orders: ParsedOrder[] = [];

  const combatMatch = content.match(COMBAT_ALERT_RE);
  if (combatMatch) {
    orders.push({
      type: "combat_warning",
      message: `WARNING: Hostile activity at ${combatMatch[3]}. ${agentName} took heavy damage from ${combatMatch[2]}. Avoid area or prepare for combat.`,
      target_agent: null,
      priority: "urgent",
    });
  }

  const oreMatch = content.match(ORE_RE);
  if (oreMatch) {
    orders.push({
      type: "ore_discovery",
      message: `ORE INTEL: ${oreMatch[1]} deposits reported at ${oreMatch[2]} by ${agentName}.`,
      target_agent: null,
      priority: "normal",
    });
  }

  const tradeMatch = content.match(TRADE_RE);
  if (tradeMatch) {
    orders.push({
      type: "trade_opportunity",
      message: `TRADE INTEL: High demand for ${tradeMatch[1]} at ${tradeMatch[2]} (reported by ${agentName}). Consider selling here.`,
      target_agent: null,
      priority: "normal",
    });
  }

  return orders;
}
