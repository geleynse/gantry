import { Router } from 'express';
import { validateAgentName } from '../config.js';
import { getTurnDetail, getAgentTurns } from '../../services/analytics-query.js';
import { queryInt } from '../middleware/query-helpers.js';

const router: Router = Router();

router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid turn ID' });
    return;
  }

  const detail = getTurnDetail(id);
  if (!detail) {
    res.status(404).json({ error: 'Turn not found' });
    return;
  }

  res.json(detail);
});

router.get('/agent/:name', (req, res) => {
  const name = req.params.name;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  const result = getAgentTurns(name, {
    hours: queryInt(req, 'hours'),
    limit: queryInt(req, 'limit') ?? 20,
    offset: queryInt(req, 'offset') ?? 0,
  });

  res.json(result);
});

export default router;
