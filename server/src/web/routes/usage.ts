import { Router } from 'express';
import { AGENTS, validateAgentName } from '../config.js';
import { parseUsageLog, getAgentUsageSummary } from '../../services/usage-parser.js';

const router: Router = Router();

router.get('/', async (req, res) => {
  // Exclude overseer from the fleet-wide usage rollup — overseer cost is
  // surfaced separately on the /overseer page (see web/routes/overseer.ts).
  const summaries = await Promise.all(
    AGENTS
      .filter((agent) => agent.name !== 'overseer')
      .map(async (agent) => ({
        name: agent.name,
        backend: agent.backend,
        model: agent.model,
        ...(await getAgentUsageSummary(agent.name, agent.model)),
      }))
  );
  res.json(summaries);
});

router.get('/:name', async (req, res) => {
  const name = req.params.name;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: `Unknown agent: ${name}` });
    return;
  }

  const agent = AGENTS.find(a => a.name === name);
  const summary = await getAgentUsageSummary(name, agent?.model);
  const detail = req.query.detail === 'true';

  if (detail) {
    const entries = await parseUsageLog(name);
    res.json({ summary, entries });
    return;
  }

  res.json({ summary });
});

export default router;
