import { Router } from 'express';
import { getAllItems } from '../../services/game-item-registry.js';
import { getAllRecipes } from '../../services/recipe-registry.js';
import { FACTION_STORAGE_CAPS } from '../../services/faction-monitor.js';

const router: Router = Router();

router.get('/faction-caps', (_req, res) => {
  res.json({ caps: FACTION_STORAGE_CAPS });
});

router.get('/items', (_req, res) => {
  try {
    const items = getAllItems();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/recipes', (_req, res) => {
  try {
    const recipes = getAllRecipes();
    res.json({ recipes });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
