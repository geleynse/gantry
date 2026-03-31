import { Router } from 'express';
import { validateAgentName } from '../config.js';
import { getAnalytics, getAllAnalytics } from '../../services/analytics-service.js';

const router: Router = Router();

router.get('/', async (req, res) => {
  const data = await getAllAnalytics();
  res.json(data);
});

router.get('/:name', async (req, res) => {
  const name = req.params.name;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  const data = await getAnalytics(name);
  res.json(data);
});

export default router;
