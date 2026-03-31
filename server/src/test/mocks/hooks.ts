import { mock } from 'bun:test';

// Local type definitions (mirrors src/hooks/use-auth.ts and use-sse.ts)
// Defined inline to avoid importing React frontend hooks into server test context
export type AuthRole = "admin" | "viewer";
export interface AuthState {
  role: AuthRole;
  identity: string | null;
  loading: boolean;
  isAdmin: boolean;
}
export interface UseSSEResult<T> {
  data: T | null;
  connected: boolean;
  error: string | null;
}

export function createMockAuthState(overrides: Partial<AuthState> = {}): AuthState {
  return {
    role: 'admin',
    identity: 'test-user',
    loading: false,
    isAdmin: true,
    ...overrides,
  };
}

export function createMockViewerAuthState(): AuthState {
  return createMockAuthState({
    role: 'viewer',
    identity: null,
    isAdmin: false,
  });
}

export function createMockLoadingAuthState(): AuthState {
  return createMockAuthState({
    loading: true,
    identity: null,
    isAdmin: false,
  });
}

export function createMockSSEResult<T>(
  data: T | null = null,
  overrides: Partial<UseSSEResult<T>> = {},
): UseSSEResult<T> {
  return {
    data,
    connected: true,
    error: null,
    ...overrides,
  };
}

/** Create a mock fetch response */
export function mockFetchResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: mock().mockResolvedValue(data),
    text: mock().mockResolvedValue(JSON.stringify(data)),
    statusText: ok ? 'OK' : 'Error',
  } as unknown as Response;
}

/** Set up global fetch to return the given data */
export function mockFetch(data: unknown, ok = true, status = 200): ReturnType<typeof mock> {
  const mockFn = mock().mockResolvedValue(mockFetchResponse(data, ok, status));
  global.fetch = mockFn as unknown as typeof fetch;
  return mockFn;
}
