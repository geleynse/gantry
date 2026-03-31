import { describe, it, expect, beforeEach } from 'bun:test';
import { NudgeStateManager, AgentNudgeState } from '../nudge-state.js';

describe('NudgeStateManager', () => {
  let manager: NudgeStateManager;
  const mockLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeEach(() => {
    manager = new NudgeStateManager(mockLogger);
  });

  describe('Initial State', () => {
    it('should initialize agent in RUNNING state', () => {
      const state = manager.getState('agent-1');
      expect(state.state).toBe('RUNNING');
      expect(state.agent_id).toBe('agent-1');
    });

    it('should have empty error chain on initialization', () => {
      const state = manager.getState('agent-1');
      expect(state.nudge_context.error_chain).toEqual([]);
      expect(state.nudge_context.level).toBe(0);
    });

    it('should have null idle context on initialization', () => {
      const state = manager.getState('agent-1');
      expect(state.idle_context.transitioned_at).toBeNull();
      expect(state.idle_context.grace_period_ends_at).toBeNull();
      expect(state.idle_context.reason).toBeNull();
    });
  });

  describe('recordError()', () => {
    it('should transition from RUNNING to NUDGE_LEVEL_1 on first error', () => {
      const state = manager.recordError('agent-1', 'Tool execution failed');
      expect(state.state).toBe('NUDGE_LEVEL_1');
      expect(state.nudge_context.level).toBe(1);
    });

    it('should increment attempt count on each error', () => {
      manager.recordError('agent-1', 'Error 1');
      expect(manager.getState('agent-1').nudge_context.attempt_count).toBe(1);
      
      manager.recordError('agent-1', 'Error 2');
      expect(manager.getState('agent-1').nudge_context.attempt_count).toBe(2);
      
      manager.recordError('agent-1', 'Error 3');
      expect(manager.getState('agent-1').nudge_context.attempt_count).toBe(3);
    });

    it('should accumulate errors in error chain', () => {
      manager.recordError('agent-1', 'First error');
      manager.recordError('agent-1', 'Second error');
      manager.recordError('agent-1', 'Third error');

      const state = manager.getState('agent-1');
      expect(state.nudge_context.error_chain.length).toBe(3);
      expect(state.nudge_context.error_chain[0].reason).toBe('First error');
      expect(state.nudge_context.error_chain[1].reason).toBe('Second error');
      expect(state.nudge_context.error_chain[2].reason).toBe('Third error');
    });

    it('should set first_failure_at timestamp on first error', () => {
      const before = Date.now();
      manager.recordError('agent-1', 'Test error');
      const after = Date.now();

      const state = manager.getState('agent-1');
      expect(state.nudge_context.first_failure_at).not.toBeNull();
      expect(state.nudge_context.first_failure_at! >= before).toBe(true);
      expect(state.nudge_context.first_failure_at! <= after).toBe(true);
    });

    it('should record error level in error chain', () => {
      manager.recordError('agent-1', 'L1 error');
      const state = manager.getState('agent-1');
      expect(state.nudge_context.error_chain[0].level).toBe(1);
    });

    it('should set last_attempt_at on each error', () => {
      manager.recordError('agent-1', 'Error 1');
      const state1 = manager.getState('agent-1');
      const time1 = state1.nudge_context.last_attempt_at!;

      // Record another error with different timestamp
      manager.recordError('agent-1', 'Error 2');
      const state2 = manager.getState('agent-1');
      const time2 = state2.nudge_context.last_attempt_at!;
      
      // Timestamps should be equal or time2 >= time1 (allowing for same ms execution)
      expect(time2 >= time1).toBe(true);
    });
  });

  describe('advanceLevel()', () => {
    it('should advance from L1 to L2 within timeout window (60s)', () => {
      manager.recordError('agent-1', 'Initial error');
      const result = manager.advanceLevel('agent-1');
      
      expect(result).toBe(true);
      const state = manager.getState('agent-1');
      expect(state.nudge_context.level).toBe(2);
      expect(state.state).toBe('NUDGE_LEVEL_2');
    });

    it('should advance from L2 to L3 within timeout window (120s)', () => {
      manager.recordError('agent-1', 'Initial error');
      manager.advanceLevel('agent-1'); // L1 -> L2
      const result = manager.advanceLevel('agent-1'); // L2 -> L3
      
      expect(result).toBe(true);
      const state = manager.getState('agent-1');
      expect(state.nudge_context.level).toBe(3);
      expect(state.state).toBe('NUDGE_LEVEL_3');
    });

    it('should fail to advance L1 if timeout exceeded', () => {
      // Manually set first_failure_at to more than 60s ago
      const state = manager.getState('agent-1');
      state.nudge_context.level = 1;
      state.nudge_context.first_failure_at = Date.now() - 65_000; // 65s ago
      state.state = 'NUDGE_LEVEL_1';

      const result = manager.advanceLevel('agent-1');
      
      expect(result).toBe(false);
      expect(manager.getState('agent-1').nudge_context.level).toBe(1);
    });

    it('should fail to advance L2 if timeout exceeded', () => {
      const state = manager.getState('agent-1');
      state.nudge_context.level = 2;
      state.nudge_context.first_failure_at = Date.now() - 125_000; // 125s ago
      state.state = 'NUDGE_LEVEL_2';

      const result = manager.advanceLevel('agent-1');
      
      expect(result).toBe(false);
      expect(manager.getState('agent-1').nudge_context.level).toBe(2);
    });

    it('should return false when at L3', () => {
      const state = manager.getState('agent-1');
      state.nudge_context.level = 3;
      state.state = 'NUDGE_LEVEL_3';

      const result = manager.advanceLevel('agent-1');
      expect(result).toBe(false);
    });
  });

  describe('nudgeSuccess()', () => {
    it('should reset state to RUNNING on successful recovery from L1', () => {
      manager.recordError('agent-1', 'L1 error');
      const state = manager.nudgeSuccess('agent-1', 1);

      expect(state.state).toBe('RUNNING');
      expect(state.nudge_context.level).toBe(0);
      expect(state.nudge_context.error_chain).toEqual([]);
      expect(state.nudge_context.attempt_count).toBe(0);
    });

    it('should reset state to RUNNING on successful recovery from L2', () => {
      manager.recordError('agent-1', 'L2 error');
      manager.advanceLevel('agent-1');
      const state = manager.nudgeSuccess('agent-1', 2);

      expect(state.state).toBe('RUNNING');
      expect(state.nudge_context.level).toBe(0);
      expect(state.nudge_context.attempt_count).toBe(0);
    });

    it('should reset state to RUNNING on successful recovery from L3', () => {
      manager.recordError('agent-1', 'L3 error');
      manager.advanceLevel('agent-1');
      manager.advanceLevel('agent-1');
      const state = manager.nudgeSuccess('agent-1', 3);

      expect(state.state).toBe('RUNNING');
      expect(state.nudge_context.level).toBe(0);
    });

    it('should clear first_failure_at on success', () => {
      manager.recordError('agent-1', 'Error');
      manager.nudgeSuccess('agent-1', 1);
      
      const state = manager.getState('agent-1');
      expect(state.nudge_context.first_failure_at).toBeNull();
    });

    it('should clear last_attempt_at on success', () => {
      manager.recordError('agent-1', 'Error');
      manager.nudgeSuccess('agent-1', 1);
      
      const state = manager.getState('agent-1');
      expect(state.nudge_context.last_attempt_at).toBeNull();
    });
  });

  describe('transitionToIdle()', () => {
    it('should transition state to IDLE', () => {
      const state = manager.transitionToIdle('agent-1', 'nudge_failed');
      expect(state.state).toBe('IDLE');
    });

    it('should set grace period ends at to 5 minutes from now', () => {
      const before = Date.now();
      const state = manager.transitionToIdle('agent-1', 'nudge_failed');
      const after = Date.now();

      const expectedEnd = before + 5 * 60_000;
      const actualEnd = state.idle_context.grace_period_ends_at!;
      
      expect(actualEnd >= expectedEnd - 100).toBe(true);
      expect(actualEnd <= expectedEnd + 100).toBe(true);
    });

    it('should set transitioned_at timestamp', () => {
      const before = Date.now();
      const state = manager.transitionToIdle('agent-1', 'nudge_failed');
      const after = Date.now();

      expect(state.idle_context.transitioned_at! >= before).toBe(true);
      expect(state.idle_context.transitioned_at! <= after).toBe(true);
    });

    it('should store the reason for transition', () => {
      const state = manager.transitionToIdle('agent-1', 'max_retries_exceeded');
      expect(state.idle_context.reason).toBe('max_retries_exceeded');
    });
  });

  describe('isIdleGracePeriodExpired()', () => {
    it('should return false if agent not in IDLE state', () => {
      manager.getState('agent-1'); // Initialize in RUNNING
      const result = manager.isIdleGracePeriodExpired('agent-1');
      expect(result).toBe(false);
    });

    it('should return false if grace period not yet expired', () => {
      manager.transitionToIdle('agent-1', 'test');
      const result = manager.isIdleGracePeriodExpired('agent-1');
      expect(result).toBe(false);
    });

    it('should return true if grace period has expired', () => {
      const state = manager.getState('agent-1');
      state.state = 'IDLE';
      state.idle_context.grace_period_ends_at = Date.now() - 1000; // Expired 1s ago
      
      const result = manager.isIdleGracePeriodExpired('agent-1');
      expect(result).toBe(true);
    });

    it('should return true if grace period end equals current time', () => {
      const now = Date.now();
      const state = manager.getState('agent-1');
      state.state = 'IDLE';
      state.idle_context.grace_period_ends_at = now;
      
      // Give a small window for execution time
      const result = manager.isIdleGracePeriodExpired('agent-1');
      expect(result).toBe(true);
    });

    it('should return false if grace_period_ends_at is null', () => {
      const state = manager.getState('agent-1');
      state.state = 'IDLE';
      state.idle_context.grace_period_ends_at = null;
      
      const result = manager.isIdleGracePeriodExpired('agent-1');
      expect(result).toBe(false);
    });
  });

  describe('resumeFromIdle()', () => {
    it('should transition from IDLE to RUNNING', () => {
      manager.transitionToIdle('agent-1', 'nudge_failed');
      const state = manager.resumeFromIdle('agent-1', 'manual');
      
      expect(state.state).toBe('RUNNING');
    });

    it('should reset nudge context', () => {
      manager.recordError('agent-1', 'Error');
      manager.advanceLevel('agent-1');
      manager.transitionToIdle('agent-1', 'nudge_failed');
      
      const state = manager.resumeFromIdle('agent-1', 'manual');
      expect(state.nudge_context.level).toBe(0);
      expect(state.nudge_context.attempt_count).toBe(0);
      expect(state.nudge_context.error_chain).toEqual([]);
    });

    it('should clear idle context', () => {
      manager.transitionToIdle('agent-1', 'nudge_failed');
      const state = manager.resumeFromIdle('agent-1', 'manual');
      
      expect(state.idle_context.transitioned_at).toBeNull();
      expect(state.idle_context.grace_period_ends_at).toBeNull();
      expect(state.idle_context.reason).toBeNull();
    });

    it('should throw error if agent not in IDLE state', () => {
      manager.getState('agent-1'); // Initialize in RUNNING
      
      expect(() => {
        manager.resumeFromIdle('agent-1', 'manual');
      }).toThrow();
    });

    it('should accept manual resume type', () => {
      manager.transitionToIdle('agent-1', 'nudge_failed');
      const state = manager.resumeFromIdle('agent-1', 'manual', 'operator-123');
      expect(state.state).toBe('RUNNING');
    });

    it('should accept auto resume type', () => {
      manager.transitionToIdle('agent-1', 'nudge_failed');
      const state = manager.resumeFromIdle('agent-1', 'auto');
      expect(state.state).toBe('RUNNING');
    });
  });

  describe('extendIdleGracePeriod()', () => {
    it('should extend grace period by another 5 minutes', () => {
      manager.transitionToIdle('agent-1', 'test');
      
      const stateBefore = manager.getState('agent-1');
      const endBefore = stateBefore.idle_context.grace_period_ends_at!;
      
      // Artificially expire the grace period to show difference
      const state = manager.getState('agent-1');
      state.idle_context.grace_period_ends_at = Date.now() - 1000;
      
      manager.extendIdleGracePeriod('agent-1');
      
      const stateAfter = manager.getState('agent-1');
      const endAfter = stateAfter.idle_context.grace_period_ends_at!;
      
      // After extending, it should have a new grace period roughly 5 minutes out
      expect(endAfter > Date.now()).toBe(true);
      expect(endAfter - Date.now() >= 4.9 * 60_000).toBe(true);
      expect(endAfter - Date.now() <= 5.1 * 60_000).toBe(true);
    });
  });

  describe('getBackoffDuration()', () => {
    it('should return 0 for L0 (RUNNING)', () => {
      manager.getState('agent-1');
      const duration = manager.getBackoffDuration('agent-1');
      expect(duration).toBe(0);
    });

    it('should return 0 for L1', () => {
      manager.recordError('agent-1', 'Error');
      const duration = manager.getBackoffDuration('agent-1');
      expect(duration).toBe(0);
    });

    it('should return 30s for L2', () => {
      manager.recordError('agent-1', 'Error');
      manager.advanceLevel('agent-1');
      const duration = manager.getBackoffDuration('agent-1');
      expect(duration).toBe(30_000);
    });

    it('should return 0 for L3', () => {
      manager.recordError('agent-1', 'Error');
      manager.advanceLevel('agent-1');
      manager.advanceLevel('agent-1');
      const duration = manager.getBackoffDuration('agent-1');
      expect(duration).toBe(0);
    });
  });

  describe('getIdleGraceTimeRemaining()', () => {
    it('should return 0 if agent not in IDLE state', () => {
      manager.getState('agent-1'); // Initialize in RUNNING
      const remaining = manager.getIdleGraceTimeRemaining('agent-1');
      expect(remaining).toBe(0);
    });

    it('should return time remaining if in grace period', () => {
      manager.transitionToIdle('agent-1', 'test');
      const remaining = manager.getIdleGraceTimeRemaining('agent-1');
      
      // Should be roughly 5 minutes
      expect(remaining > 4.5 * 60_000).toBe(true);
      expect(remaining <= 5 * 60_000).toBe(true);
    });

    it('should return 0 if grace period expired', () => {
      const state = manager.getState('agent-1');
      state.state = 'IDLE';
      state.idle_context.grace_period_ends_at = Date.now() - 1000;
      
      const remaining = manager.getIdleGraceTimeRemaining('agent-1');
      expect(remaining).toBe(0);
    });
  });

  describe('getAllStates()', () => {
    it('should return all agent states', () => {
      manager.getState('agent-1');
      manager.getState('agent-2');
      manager.getState('agent-3');
      
      const all = manager.getAllStates();
      expect(all.length).toBe(3);
    });

    it('should return empty array if no agents initialized', () => {
      const mgr = new NudgeStateManager(mockLogger);
      const all = mgr.getAllStates();
      expect(all.length).toBe(0);
    });
  });

  describe('getAgentsByState()', () => {
    it('should filter agents by state', () => {
      manager.recordError('agent-1', 'Error');
      manager.recordError('agent-2', 'Error');
      manager.getState('agent-3'); // RUNNING
      
      const nudgeL1 = manager.getAgentsByState('NUDGE_LEVEL_1');
      expect(nudgeL1.length).toBe(2);
      expect(nudgeL1[0].agent_id).toBe('agent-1');
    });

    it('should return empty array for state with no agents', () => {
      manager.getState('agent-1'); // RUNNING
      
      const idle = manager.getAgentsByState('IDLE');
      expect(idle.length).toBe(0);
    });
  });

  describe('clearState()', () => {
    it('should remove agent state', () => {
      manager.getState('agent-1');
      manager.clearState('agent-1');
      
      // Getting state after clear should create new state
      const state = manager.getState('agent-1');
      expect(state.state).toBe('RUNNING');
      expect(state.nudge_context.level).toBe(0);
    });

    it('should not affect other agents', () => {
      manager.recordError('agent-1', 'Error');
      manager.getState('agent-2');
      
      manager.clearState('agent-1');
      
      const state2 = manager.getState('agent-2');
      expect(state2.state).toBe('RUNNING');
    });
  });
});
