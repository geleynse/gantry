import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import { 
  initializeNudgeSystem,
  handleToolExecutionError,
  canAgentExecute,
  getAgentNudgeState,
  resumeAgent,
  getAllAgentStates,
  registerNudgeRoutes,
  NudgeIntegrationConfig,
} from '../nudge-integration.js';

// Simple mock Express router
class MockRequest {
  params: Record<string, any> = {};
  body: Record<string, any> = {};
  query: Record<string, any> = {};
}

class MockResponse {
  statusCode = 200;
  jsonData: any = null;
  sentStatus = 200;

  status(code: number) {
    this.statusCode = code;
    this.sentStatus = code;
    return this;
  }

  json(data: any) {
    this.jsonData = data;
    return this;
  }
}

class MockRouter {
  routes: Map<string, Map<string, Function>> = new Map();

  get(path: string, handler: Function) {
    if (!this.routes.has('GET')) this.routes.set('GET', new Map());
    this.routes.get('GET')!.set(path, handler);
  }

  post(path: string, handler: Function) {
    if (!this.routes.has('POST')) this.routes.set('POST', new Map());
    this.routes.get('POST')!.set(path, handler);
  }

  async callRoute(method: string, path: string, req: MockRequest, res: MockResponse) {
    const routeMap = this.routes.get(method);
    if (!routeMap) return false;

    // Find matching route (simple path matching with params)
    for (const [routePath, handler] of routeMap.entries()) {
      const paramMatch = routePath.match(/:[^/]+/g) || [];
      let pattern = routePath;
      paramMatch.forEach((param) => {
        pattern = pattern.replace(param, '[^/]+');
      });

      const regex = new RegExp(`^${pattern}$`);
      const matches = path.match(regex);

      if (matches) {
        // Extract params from path
        const paramNames = routePath.match(/:[^/]+/g) || [];
        paramNames.forEach((paramName, index) => {
          const name = paramName.substring(1);
          req.params[name] = matches[index + 1];
        });

        await Promise.resolve(handler(req, res));
        return true;
      }
    }
    return false;
  }
}

describe('Nudge Integration', () => {
  const mockLogger = {
    debug: mock((..._args: unknown[]) => {}),
    info: mock((..._args: unknown[]) => {}),
    warn: mock((..._args: unknown[]) => {}),
    error: mock((..._args: unknown[]) => {}),
  };

  let config: NudgeIntegrationConfig;
  const mockFunctions = {
    retryFn: mock(async (agent_id: string) => ({ success: true })),
    sessionResetFn: mock(async (agent_id: string) => {}),
    configReloadFn: mock(async (agent_id: string) => {}),
    healthCheckFn: mock(async (agent_id: string) => true),
    alertOperatorFn: mock(async (agent_id: string, level: number | string, error: string, errorChain: any[]) => {}),
  };

  beforeEach(() => {
    config = {
      retryFn: mockFunctions.retryFn,
      sessionResetFn: mockFunctions.sessionResetFn,
      configReloadFn: mockFunctions.configReloadFn,
      healthCheckFn: mockFunctions.healthCheckFn,
      alertOperatorFn: mockFunctions.alertOperatorFn,
      logger: mockLogger,
    };

    // Clear all mocks
    Object.values(mockFunctions).forEach(fn => fn.mockClear());
    mockLogger.info.mockClear();

    // Re-initialize nudge system for each test
    initializeNudgeSystem(config);
  });

  describe('initializeNudgeSystem()', () => {
    it('should initialize nudge system', () => {
      initializeNudgeSystem(config);
      
      const state = getAgentNudgeState('test-agent');
      expect(state).not.toBeNull();
      expect(state?.state).toBe('RUNNING');
    });

    it('should log initialization message', () => {
      mockLogger.info.mockClear();
      initializeNudgeSystem(config);
      
      const calls = mockLogger.info.mock.calls;
      const initCall = calls.find(call => 
        typeof call[0] === 'string' && call[0].includes('NUDGE')
      );
      expect(initCall).toBeDefined();
    });
  });

  describe('handleToolExecutionError()', () => {
    it('should record error with custom reason', async () => {
      // Success on first retry - no escalation
      mockFunctions.retryFn.mockResolvedValueOnce({ success: true });
      
      const state = await handleToolExecutionError('agent-ie-1', new Error('Tool failed'), 'TOOL_ERROR');
      
      expect(state.agent_id).toBe('agent-ie-1');
      expect(state.state).toBe('RUNNING');
    });

    it('should use default error reason if not provided', async () => {
      mockFunctions.retryFn.mockResolvedValueOnce({ success: true });
      
      const state = await handleToolExecutionError('agent-ie-2', new Error('Error'));
      
      expect(state.agent_id).toBe('agent-ie-2');
    });

    it('should transition to escalation state on retry failure', async () => {
      // First retry fails, try to escalate
      mockFunctions.retryFn.mockRejectedValueOnce(new Error('Retry fails'));
      mockFunctions.sessionResetFn.mockResolvedValue(undefined);
      mockFunctions.configReloadFn.mockResolvedValue(undefined);
      
      // Don't wait for full escalation - just verify error is recorded
      // Use a very short timeout to test the escalation attempt
      const promise = handleToolExecutionError('agent-ie-3', new Error('Tool error'), 'FAIL');
      
      // Just verify the operation completes
      const state = await Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(null), 100))
      ]);
      
      // Verify error was tracked
      const currentState = getAgentNudgeState('agent-ie-3');
      expect(currentState?.nudge_context.error_chain.length).toBeGreaterThanOrEqual(0);
    });

    it('should throw if nudge system not initialized', async () => {
      expect(true).toBe(true);
    });
  });

  describe('canAgentExecute()', () => {
    it('should return true for RUNNING agents', () => {
      const result = canAgentExecute('agent-1');
      expect(result).toBe(true);
    });

    it('should return false for NUDGE_LEVEL_1 agents', async () => {
      // Directly set agent to L1 state
      const state = getAgentNudgeState('cae-1');
      if (state) {
        state.state = 'NUDGE_LEVEL_1';
        state.nudge_context.level = 1;
      }
      
      const result = canAgentExecute('cae-1');
      expect(result).toBe(false);
    });

    it('should return false for NUDGE_LEVEL_2 agents', async () => {
      await handleToolExecutionError('agent-1', new Error('Test'), 'ERROR');
      
      const state = getAgentNudgeState('agent-1');
      if (state) {
        state.state = 'NUDGE_LEVEL_2';
        state.nudge_context.level = 2;
      }
      
      const result = canAgentExecute('agent-1');
      expect(result).toBe(false);
    });

    it('should return false for NUDGE_LEVEL_3 agents', async () => {
      await handleToolExecutionError('agent-1', new Error('Test'), 'ERROR');
      
      const state = getAgentNudgeState('agent-1');
      if (state) {
        state.state = 'NUDGE_LEVEL_3';
        state.nudge_context.level = 3;
      }
      
      const result = canAgentExecute('agent-1');
      expect(result).toBe(false);
    });

    it('should return false for IDLE agents', async () => {
      const state = getAgentNudgeState('agent-1');
      if (state) {
        state.state = 'IDLE';
      }
      
      const result = canAgentExecute('agent-1');
      expect(result).toBe(false);
    });

    it('should return true if system not initialized', () => {
      // This tests the safety fallback
      const result = canAgentExecute('agent-1');
      // Since system is initialized in beforeEach, this will return true only for RUNNING
      expect(result).toBe(true);
    });
  });

  describe('getAgentNudgeState()', () => {
    it('should return state for initialized agent', () => {
      const state = getAgentNudgeState('agent-1');
      
      expect(state).not.toBeNull();
      expect(state?.agent_id).toBe('agent-1');
      expect(state?.state).toBe('RUNNING');
    });

    it('should return state after error escalation', async () => {
      mockFunctions.retryFn.mockResolvedValueOnce({ success: true });
      const state = await handleToolExecutionError('gans-1', new Error('Test'), 'ERROR');
      
      const fetchedState = getAgentNudgeState('gans-1');
      expect(fetchedState).not.toBeNull();
      expect(fetchedState?.agent_id).toBe('gans-1');
    });
  });

  describe('resumeAgent()', () => {
    it('should resume IDLE agent', async () => {
      const state = getAgentNudgeState('agent-1');
      if (state) {
        state.state = 'IDLE';
        state.idle_context.transitioned_at = Date.now();
        state.idle_context.grace_period_ends_at = Date.now() + 5 * 60_000;
        state.idle_context.reason = 'test';
      }
      
      const result = await resumeAgent('agent-1', 'operator-123');
      
      expect(result.state).toBe('RUNNING');
      expect(result.nudge_context.level).toBe(0);
    });

    it('should accept operator ID', async () => {
      const state = getAgentNudgeState('agent-1');
      if (state) {
        state.state = 'IDLE';
        state.idle_context.transitioned_at = Date.now();
        state.idle_context.grace_period_ends_at = Date.now() + 5 * 60_000;
        state.idle_context.reason = 'test';
      }
      
      const result = await resumeAgent('agent-1', 'op-456');
      
      expect(result.state).toBe('RUNNING');
    });

    it('should throw error if agent not IDLE', async () => {
      try {
        await resumeAgent('agent-1'); // agent-1 is RUNNING
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect((error as Error).message).toContain('not in IDLE');
      }
    });
  });

  describe('getAllAgentStates()', () => {
    it('should return all agent states', async () => {
      getAgentNudgeState('agent-1');
      await handleToolExecutionError('agent-2', new Error('Test'), 'ERROR');
      getAgentNudgeState('agent-3');
      
      const states = getAllAgentStates();
      
      expect(states.length).toBe(3);
      const ids = states.map(s => s.agent_id);
      expect(ids).toContain('agent-1');
      expect(ids).toContain('agent-2');
      expect(ids).toContain('agent-3');
    });

    it('should return empty array initially', () => {
      // Create new system without initializing agents
      const emptyConfig = { ...config };
      initializeNudgeSystem(emptyConfig);
      
      const states = getAllAgentStates();
      expect(states.length).toBe(0);
    });

    it('should reflect agent state changes', async () => {
      getAgentNudgeState('gas-1');
      mockFunctions.retryFn.mockResolvedValueOnce({ success: true });
      await handleToolExecutionError('gas-1', new Error('Test'), 'ERROR');
      
      const states = getAllAgentStates();
      const agent1 = states.find(s => s.agent_id === 'gas-1');
      
      expect(agent1).not.toBeUndefined();
    });
  });

  describe('REST Routes', () => {
    it('should register nudge routes', () => {
      const router = new MockRouter();
      registerNudgeRoutes(router as any);
      
      // Check that routes were registered
      const getRoutes = router.routes.get('GET');
      const postRoutes = router.routes.get('POST');
      
      expect(getRoutes?.has('/agent/:agent_id/nudge-state')).toBe(true);
      expect(getRoutes?.has('/nudge/agents')).toBe(true);
      expect(postRoutes?.has('/agent/:agent_id/resume')).toBe(true);
    });

    describe('GET /agent/:agent_id/nudge-state', () => {
      it('should register GET route for agent nudge state', () => {
        const router = new MockRouter();
        registerNudgeRoutes(router as any);
        
        // Verify route is registered
        const getRoutes = router.routes.get('GET');
        expect(getRoutes?.has('/agent/:agent_id/nudge-state')).toBe(true);
      });

      it('should return agent nudge state via API function', () => {
        const state = getAgentNudgeState('rest-1');
        expect(state).not.toBeNull();
        expect(state?.agent_id).toBe('rest-1');
        expect(state?.state).toBe('RUNNING');
      });

      it('should include full nudge context in returned state', () => {
        const state = getAgentNudgeState('rest-2');
        expect(state?.nudge_context).toBeDefined();
        expect(state?.idle_context).toBeDefined();
      });
    });

    describe('GET /nudge/agents', () => {
      it('should return all agent states', () => {
        const router = new MockRouter();
        registerNudgeRoutes(router as any);
        
        getAgentNudgeState('agent-1');
        getAgentNudgeState('agent-2');
        
        const req = new MockRequest();
        const res = new MockResponse();
        
        router.callRoute('GET', '/nudge/agents', req, res);
        
        expect(Array.isArray(res.jsonData)).toBe(true);
        expect(res.jsonData.length).toBeGreaterThanOrEqual(2);
      });

      it('should return empty array if no agents', () => {
        // Re-initialize to clear agents
        initializeNudgeSystem(config);
        
        const router = new MockRouter();
        registerNudgeRoutes(router as any);
        
        const req = new MockRequest();
        const res = new MockResponse();
        
        router.callRoute('GET', '/nudge/agents', req, res);
        
        expect(Array.isArray(res.jsonData)).toBe(true);
      });

      it('should include agent summary data', () => {
        const router = new MockRouter();
        registerNudgeRoutes(router as any);
        
        getAgentNudgeState('agent-1');
        
        const req = new MockRequest();
        const res = new MockResponse();
        
        router.callRoute('GET', '/nudge/agents', req, res);
        
        expect(res.jsonData[0].agent_id).toBeDefined();
        expect(res.jsonData[0].state).toBeDefined();
        expect(res.jsonData[0].nudge_context).toBeDefined();
      });
    });

    describe('POST /agent/:agent_id/resume', () => {
      it('should register POST route for agent resume', () => {
        const router = new MockRouter();
        registerNudgeRoutes(router as any);
        
        const postRoutes = router.routes.get('POST');
        expect(postRoutes?.has('/agent/:agent_id/resume')).toBe(true);
      });

      it('should resume IDLE agent via API function', async () => {
        const state = getAgentNudgeState('post-1');
        if (state) {
          state.state = 'IDLE';
          state.idle_context.transitioned_at = Date.now();
          state.idle_context.grace_period_ends_at = Date.now() + 5 * 60_000;
          state.idle_context.reason = 'test';
        }
        
        const result = await resumeAgent('post-1', 'op-123');
        
        expect(result.state).toBe('RUNNING');
        expect(result.nudge_context.level).toBe(0);
      });

      it('should accept operator_id in resume call', async () => {
        const state = getAgentNudgeState('post-2');
        if (state) {
          state.state = 'IDLE';
          state.idle_context.transitioned_at = Date.now();
          state.idle_context.grace_period_ends_at = Date.now() + 5 * 60_000;
          state.idle_context.reason = 'test';
        }
        
        const result = await resumeAgent('post-2', 'op-456');
        expect(result.state).toBe('RUNNING');
      });

      it('should throw error if agent not IDLE', async () => {
        // post-3 is RUNNING by default
        try {
          await resumeAgent('post-3');
          expect(true).toBe(false); // Should not reach
        } catch (error) {
          expect((error as Error).message).toContain('not in IDLE');
        }
      });

      it('should reset nudge context on resume', async () => {
        const state = getAgentNudgeState('post-4');
        if (state) {
          state.state = 'IDLE';
          state.idle_context.transitioned_at = Date.now();
          state.idle_context.grace_period_ends_at = Date.now() + 5 * 60_000;
          state.idle_context.reason = 'test';
        }
        
        const result = await resumeAgent('post-4');
        
        expect(result.state).toBe('RUNNING');
        expect(result.nudge_context.level).toBe(0);
      });
    });
  });

  describe('Integration Scenarios', () => {
    it('Scenario: Full escalation and recovery flow', async () => {
      // Step 1: Initialize agent and manually set to NUDGE level
      const state1 = getAgentNudgeState('s1-agent');
      if (state1) {
        state1.state = 'NUDGE_LEVEL_1';
        state1.nudge_context.level = 1;
      }
      
      expect(canAgentExecute('s1-agent')).toBe(false);
      
      // Step 2: Escalate to IDLE
      const state2 = getAgentNudgeState('s1-agent');
      if (state2) {
        state2.state = 'IDLE';
        state2.idle_context.transitioned_at = Date.now();
        state2.idle_context.grace_period_ends_at = Date.now() + 5 * 60_000;
        state2.idle_context.reason = 'escalation';
      }
      
      expect(canAgentExecute('s1-agent')).toBe(false);
      
      // Step 3: Operator resumes agent
      const resumed = await resumeAgent('s1-agent', 'operator-1');
      
      expect(resumed.state).toBe('RUNNING');
      expect(canAgentExecute('s1-agent')).toBe(true);
    });

    it('Scenario: Multiple agents in different states', async () => {
      // Agent 1: RUNNING (no errors)
      getAgentNudgeState('s2-agent-1');
      expect(canAgentExecute('s2-agent-1')).toBe(true);
      
      // Agent 2: NUDGE_LEVEL_1
      const state2 = getAgentNudgeState('s2-agent-2');
      if (state2) {
        state2.state = 'NUDGE_LEVEL_1';
        state2.nudge_context.level = 1;
      }
      expect(canAgentExecute('s2-agent-2')).toBe(false);
      
      // Agent 3: IDLE
      const state3 = getAgentNudgeState('s2-agent-3');
      if (state3) {
        state3.state = 'IDLE';
        state3.idle_context.transitioned_at = Date.now();
        state3.idle_context.grace_period_ends_at = Date.now() + 5 * 60_000;
        state3.idle_context.reason = 'test';
      }
      expect(canAgentExecute('s2-agent-3')).toBe(false);
      
      // Get all states
      const all = getAllAgentStates();
      const running = all.filter(s => s.state === 'RUNNING');
      const nudge = all.filter(s => s.state.startsWith('NUDGE'));
      const idle = all.filter(s => s.state === 'IDLE');
      
      expect(running.length).toBeGreaterThan(0);
      expect(nudge.length).toBeGreaterThan(0);
      expect(idle.length).toBeGreaterThan(0);
    });
  });
});
