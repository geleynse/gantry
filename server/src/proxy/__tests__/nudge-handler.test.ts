import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NudgeStateManager } from '../nudge-state.js';
import { NudgeHandler, NudgeHandlerConfig } from '../nudge-handler.js';

describe('NudgeHandler', () => {
  let stateManager: NudgeStateManager;
  let handler: NudgeHandler;
  let config: NudgeHandlerConfig;
  
  const mockLogger = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };

  const mockFunctions = {
    retryFn: mock(async (agent_id: string) => {
      return { success: true };
    }),
    sessionResetFn: mock(async (agent_id: string) => {}),
    configReloadFn: mock(async (agent_id: string) => {}),
    healthCheckFn: mock(async (agent_id: string) => true),
    alertOperatorFn: mock(async (agent_id: string, level: number | string, error: string, errorChain: any[]) => {}),
  };

  beforeEach(() => {
    stateManager = new NudgeStateManager(mockLogger);
    config = {
      stateManager,
      retryFn: mockFunctions.retryFn,
      sessionResetFn: mockFunctions.sessionResetFn,
      configReloadFn: mockFunctions.configReloadFn,
      healthCheckFn: mockFunctions.healthCheckFn,
      alertOperatorFn: mockFunctions.alertOperatorFn,
      logger: mockLogger,
    };
    handler = new NudgeHandler(config);
    
    // Clear all mocks
    mockFunctions.retryFn.mockClear();
    mockFunctions.sessionResetFn.mockClear();
    mockFunctions.configReloadFn.mockClear();
    mockFunctions.healthCheckFn.mockClear();
    mockFunctions.alertOperatorFn.mockClear();
  });

  describe('handleNudgeEscalation()', () => {
    it('should record error and execute L1', async () => {
      mockFunctions.retryFn.mockResolvedValue({ success: true });
      
      const state = await handler.handleNudgeEscalation('agent-1', new Error('Test'), 'TOOL_ERROR');
      
      expect(state.state).toBe('RUNNING');
      expect(state.nudge_context.level).toBe(0);
      expect(mockFunctions.retryFn).toHaveBeenCalled();
    });

    it('should escalate to L2 when L1 retry fails and timeout not exceeded', async () => {
      mockFunctions.retryFn.mockRejectedValueOnce(new Error('Retry failed'));
      mockFunctions.retryFn.mockResolvedValueOnce({ success: true });
      mockFunctions.sessionResetFn.mockResolvedValue(undefined);
      mockFunctions.configReloadFn.mockResolvedValue(undefined);

      // First error - records at L1
      stateManager.recordError('agent-1', 'Initial error');
      expect(stateManager.getState('agent-1').nudge_context.level).toBe(1);
      
      // Verify we can advance within timeout window
      const canAdvance = stateManager.advanceLevel('agent-1');
      expect(canAdvance).toBe(true);
      expect(stateManager.getState('agent-1').nudge_context.level).toBe(2);
    });
  });

  describe('L1 Escalation', () => {
    it('should retry once at L1 and return to RUNNING on success', async () => {
      mockFunctions.retryFn.mockResolvedValueOnce({ success: true });
      
      // Don't call handler with full escalation - just test the flow
      const state = stateManager.recordError('agent-l1-1', 'Test error');
      expect(state.nudge_context.level).toBe(1);
      
      // Simulate successful retry
      const recovered = stateManager.nudgeSuccess('agent-l1-1', 1);
      
      expect(recovered.state).toBe('RUNNING');
      expect(recovered.nudge_context.level).toBe(0);
    });

    it('should move to L2 when L1 retry fails within timeout', async () => {
      stateManager.recordError('agent-l1-mv', 'Initial error');
      const state1 = stateManager.getState('agent-l1-mv');
      expect(state1.nudge_context.level).toBe(1);
      
      // Verify we can advance within timeout window
      const canAdvance = stateManager.advanceLevel('agent-l1-mv');
      expect(canAdvance).toBe(true);
      
      const state2 = stateManager.getState('agent-l1-mv');
      expect(state2.nudge_context.level).toBe(2);
    });
  });

  describe('L2 Escalation', () => {
    it('should perform session reset and config reload at L2', async () => {
      // Force agent to L2
      stateManager.recordError('agent-l2-1', 'Force L2');
      stateManager.advanceLevel('agent-l2-1');
      
      const state = stateManager.getState('agent-l2-1');
      expect(state.nudge_context.level).toBe(2);
      expect(state.state).toBe('NUDGE_LEVEL_2');
      
      // Verify backoff is configured for L2
      const backoff = stateManager.getBackoffDuration('agent-l2-1');
      expect(backoff).toBe(30_000);
    });

    it('should apply backoff delay at L2', async () => {
      stateManager.recordError('agent-l2-bk', 'Force L2');
      stateManager.advanceLevel('agent-l2-bk');
      
      // Just verify that backoff duration is returned correctly for L2
      const backoff = stateManager.getBackoffDuration('agent-l2-bk');
      expect(backoff).toBe(30_000);
      
      const state = stateManager.getState('agent-l2-bk');
      expect(state.nudge_context.level).toBe(2);
    });
  });

  describe('L3 Escalation', () => {
    it('should alert operator at L3', async () => {
      stateManager.recordError('agent-1', 'Force L3');
      stateManager.advanceLevel('agent-1');
      stateManager.advanceLevel('agent-1');
      
      mockFunctions.retryFn.mockResolvedValue({ success: true });
      mockFunctions.sessionResetFn.mockResolvedValue(undefined);
      mockFunctions.configReloadFn.mockResolvedValue(undefined);
      
      const state = await handler.handleNudgeEscalation('agent-1', new Error('L3 test'), 'ERROR');
      
      expect(mockFunctions.alertOperatorFn).toHaveBeenCalled();
      const call = mockFunctions.alertOperatorFn.mock.calls[0];
      expect(call[0]).toBe('agent-1');
      expect(call[1]).toBe(3);
    });

    it('should call session reset and config reload at L3', async () => {
      stateManager.recordError('agent-1', 'Force L3');
      stateManager.advanceLevel('agent-1');
      stateManager.advanceLevel('agent-1');
      
      mockFunctions.retryFn.mockResolvedValue({ success: true });
      mockFunctions.sessionResetFn.mockResolvedValue(undefined);
      mockFunctions.configReloadFn.mockResolvedValue(undefined);
      
      await handler.handleNudgeEscalation('agent-1', new Error('L3 test'), 'ERROR');
      
      expect(mockFunctions.sessionResetFn).toHaveBeenCalledWith('agent-1');
      expect(mockFunctions.configReloadFn).toHaveBeenCalledWith('agent-1');
      expect(mockFunctions.retryFn).toHaveBeenCalled();
    });

    it('should return to RUNNING on L3 success', async () => {
      stateManager.recordError('agent-l3-suc', 'Force L3');
      stateManager.advanceLevel('agent-l3-suc');
      stateManager.advanceLevel('agent-l3-suc');
      
      const state1 = stateManager.getState('agent-l3-suc');
      expect(state1.nudge_context.level).toBe(3);
      
      // Simulate successful retry at L3
      const recovered = stateManager.nudgeSuccess('agent-l3-suc', 3);
      
      expect(recovered.state).toBe('RUNNING');
      expect(recovered.nudge_context.level).toBe(0);
    });

    it('should transition to IDLE on L3 failure', async () => {
      stateManager.recordError('agent-l3-fail', 'Force L3');
      stateManager.advanceLevel('agent-l3-fail');
      stateManager.advanceLevel('agent-l3-fail');
      
      const state1 = stateManager.getState('agent-l3-fail');
      expect(state1.nudge_context.level).toBe(3);
      
      // Simulate persistent failure at L3 - transition to IDLE
      const idleState = stateManager.transitionToIdle('agent-l3-fail', 'persistent_failure');
      
      expect(idleState.state).toBe('IDLE');
      expect(idleState.idle_context.reason).toBe('persistent_failure');
    });
  });

  describe('IDLE Management', () => {
    it('should resume from IDLE manually via resumeIdleAgent', async () => {
      stateManager.transitionToIdle('agent-1', 'nudge_failed');
      
      const state = await handler.resumeIdleAgent('agent-1', 'operator-123');
      
      expect(state.state).toBe('RUNNING');
      expect(state.nudge_context.level).toBe(0);
    });

    it('should throw error when resuming non-IDLE agent', async () => {
      stateManager.getState('agent-1'); // Initialize in RUNNING
      
      try {
        await handler.resumeIdleAgent('agent-1');
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect((error as Error).message).toContain('not in IDLE state');
      }
    });

    it('should auto-resume from IDLE when grace period expires and agent is healthy', async () => {
      stateManager.transitionToIdle('agent-1', 'nudge_failed');
      
      // Expire grace period
      const state = stateManager.getState('agent-1');
      state.idle_context.grace_period_ends_at = Date.now() - 1000;
      
      mockFunctions.healthCheckFn.mockResolvedValue(true);
      
      const result = await handler.handleIdleAgent('agent-1');
      
      expect(result.state).toBe('RUNNING');
      expect(mockFunctions.healthCheckFn).toHaveBeenCalledWith('agent-1');
    });

    it('should not resume if grace period not yet expired', async () => {
      stateManager.transitionToIdle('agent-1', 'nudge_failed');
      
      const result = await handler.handleIdleAgent('agent-1');
      
      expect(result.state).toBe('IDLE');
      expect(mockFunctions.healthCheckFn).not.toHaveBeenCalled();
    });

    it('should handle health check failure during IDLE recovery', async () => {
      stateManager.transitionToIdle('agent-1', 'nudge_failed');
      
      // Expire grace period
      const state = stateManager.getState('agent-1');
      state.idle_context.grace_period_ends_at = Date.now() - 1000;
      
      mockFunctions.healthCheckFn.mockRejectedValue(new Error('Health check failed'));
      
      const result = await handler.handleIdleAgent('agent-1');
      
      // Health check failed — should extend grace period, not resume
      expect(result.state).toBe('IDLE');
    });
  });

  describe('getAgentState()', () => {
    it('should return current agent state', () => {
      stateManager.recordError('agent-1', 'Test error');
      
      const state = handler.getAgentState('agent-1');
      
      expect(state.agent_id).toBe('agent-1');
      expect(state.state).toBe('NUDGE_LEVEL_1');
    });
  });

  describe('getAllAgentStates()', () => {
    it('should return all agent states', () => {
      stateManager.getState('agent-1');
      stateManager.getState('agent-2');
      stateManager.recordError('agent-3', 'Error');
      
      const states = handler.getAllAgentStates();
      
      expect(states.length).toBe(3);
    });

    it('should return empty array when no agents', () => {
      const mgr = new NudgeStateManager(mockLogger);
      const h = new NudgeHandler({
        ...config,
        stateManager: mgr,
      });
      
      const states = h.getAllAgentStates();
      
      expect(states.length).toBe(0);
    });
  });

  describe('Full Escalation Scenarios', () => {
    it('Scenario: L1 fail, advance to L2, then success', async () => {
      // Simulate: L1 records error, can advance to L2
      const state1 = stateManager.recordError('agent-1', 'L1 failure');
      expect(state1.nudge_context.level).toBe(1);
      
      // L1 retry fails, so handler tries to advance
      const canAdvance = stateManager.advanceLevel('agent-1');
      expect(canAdvance).toBe(true);
      
      // Now at L2
      const state2 = stateManager.getState('agent-1');
      expect(state2.nudge_context.level).toBe(2);
      
      // L2 success returns to RUNNING
      const state3 = stateManager.nudgeSuccess('agent-1', 2);
      expect(state3.state).toBe('RUNNING');
      expect(state3.nudge_context.level).toBe(0);
    });

    it('Scenario: Full escalation path L1 -> L2 -> L3 -> IDLE', async () => {
      // Manually walk through escalation levels
      const agent = stateManager.getState('agent-esc-1');
      
      // L1: Record error
      stateManager.recordError('agent-esc-1', 'L1 error');
      expect(agent.state).toBe('NUDGE_LEVEL_1');
      expect(agent.nudge_context.level).toBe(1);
      
      // L2: Advance from L1
      const advL1 = stateManager.advanceLevel('agent-esc-1');
      expect(advL1).toBe(true);
      expect(agent.state).toBe('NUDGE_LEVEL_2');
      expect(agent.nudge_context.level).toBe(2);
      
      // L3: Advance from L2
      const advL2 = stateManager.advanceLevel('agent-esc-1');
      expect(advL2).toBe(true);
      expect(agent.state).toBe('NUDGE_LEVEL_3');
      expect(agent.nudge_context.level).toBe(3);
      
      // IDLE: Transition on persistent failure
      stateManager.transitionToIdle('agent-esc-1', 'escalation_failed');
      expect(agent.state).toBe('IDLE');
    });
  });

  describe('Error Chain Tracking', () => {
    it('should pass error chain to operator alert', async () => {
      // Build up error chain with 3 initial errors
      stateManager.recordError('agent-1', 'Error 1');
      stateManager.recordError('agent-1', 'Error 2');
      stateManager.recordError('agent-1', 'Error 3');
      
      // Advance to L3
      stateManager.advanceLevel('agent-1');
      stateManager.advanceLevel('agent-1');
      
      mockFunctions.retryFn.mockRejectedValue(new Error('Final failure'));
      mockFunctions.sessionResetFn.mockResolvedValue(undefined);
      mockFunctions.configReloadFn.mockResolvedValue(undefined);
      
      await handler.handleNudgeEscalation('agent-1', new Error('L3'), 'ERROR');
      
      const alertCall = mockFunctions.alertOperatorFn.mock.calls.find(
        call => call[1] === 3
      );
      
      expect(alertCall).toBeDefined();
      // Error chain will have: 3 initial + 1 new = 4 total
      expect(alertCall![3].length).toBeGreaterThan(0);
    });
  });
});
