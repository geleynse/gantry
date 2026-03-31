import { Router } from 'express';
import { validateAgentName } from '../config.js';
import { createSignal, consumeSignal, hasSignal, clearSignal } from '../../services/signals-db.js';
import { agentControlLimiter } from '../middleware/rate-limit.js';

const router: Router = Router();

export const MAX_INSTRUCTION_LENGTH = 10_240;

/**
 * Normalize inject text before persistence.
 * - Normalizes Windows newlines to LF
 * - Removes non-printable ASCII control chars (except tab/newline)
 * - Trims outer whitespace
 */
export function sanitizeInjectInstruction(instruction: string): string {
  return instruction
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

export function validateInjectInstruction(
  instruction: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof instruction !== 'string') {
    return { ok: false, message: '`instruction` must be a non-empty string' };
  }

  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    return {
      ok: false,
      message: `\`instruction\` must not exceed ${MAX_INSTRUCTION_LENGTH} characters (got ${instruction.length})`,
    };
  }

  const sanitized = sanitizeInjectInstruction(instruction);
  if (sanitized.length === 0) {
    return { ok: false, message: '`instruction` must be a non-empty string' };
  }

  return { ok: true, value: sanitized };
}

// Get pending inject instruction for an agent (consumes it)
router.get('/:name/inject', (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  const message = consumeSignal(name, 'inject');
  res.json({ instruction: message });
});

// Set an inject instruction for an agent
router.post('/:name/inject', agentControlLimiter, async (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  const validation = validateInjectInstruction((req.body ?? {}).instruction);
  if (!validation.ok) {
    res.status(400).json({ error: 'validation_error', message: validation.message });
    return;
  }

  createSignal(name, 'inject', validation.value);
  res.json({ ok: true });
});

// Shutdown signal routes
router.get('/:name/shutdown', (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  res.json({ pending: hasSignal(name, 'shutdown') });
});

router.post('/:name/shutdown', agentControlLimiter, async (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  const body = req.body ?? {};
  createSignal(name, 'shutdown', (body as Record<string, string>).message ?? '');
  res.json({ ok: true });
});

router.delete('/:name/shutdown', (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  clearSignal(name, 'shutdown');
  res.json({ ok: true });
});

export default router;
