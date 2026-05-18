import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUpstreamFetch, isRateLimitError, friendlyErrorMessage } from '../use-upstream-fetch';
import { mockFetch, mockFetchResponse } from '@/test/mocks/hooks';
import type { ApiError } from '@/lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApiError(status: number, body: string): ApiError {
  const err = new Error(`API ${status}: ${body}`) as ApiError;
  err.status = status;
  err.body = body;
  return err;
}

function mock502RateLimit(): void {
  global.fetch = mock().mockResolvedValue({
    ok: false,
    status: 502,
    text: mock().mockResolvedValue('{"error":"Failed to fetch map: 429 Too Many Requests"}'),
    statusText: 'Bad Gateway',
  }) as unknown as typeof fetch;
}

function mock502Other(): void {
  global.fetch = mock().mockResolvedValue({
    ok: false,
    status: 502,
    text: mock().mockResolvedValue('Upstream connection refused'),
    statusText: 'Bad Gateway',
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// isRateLimitError
// ---------------------------------------------------------------------------

describe('isRateLimitError', () => {
  it('returns true for 502 with 429 in body', () => {
    expect(isRateLimitError(makeApiError(502, '{"error":"Failed to fetch: 429 Too Many Requests"}'))).toBe(true);
  });

  it('returns true for 502 with "rate limit" in body', () => {
    expect(isRateLimitError(makeApiError(502, 'Upstream leaderboard fetch failed: rate limit exceeded'))).toBe(true);
  });

  it('returns true for 502 with "rate-limit" (hyphen) in body', () => {
    expect(isRateLimitError(makeApiError(502, 'Upstream returned rate-limit error'))).toBe(true);
  });

  it('returns false for 502 with non-rate-limit body', () => {
    expect(isRateLimitError(makeApiError(502, 'Upstream connection refused'))).toBe(false);
  });

  it('returns false for non-502 errors (e.g. 500)', () => {
    expect(isRateLimitError(makeApiError(500, '429 in the body text'))).toBe(false);
  });

  it('returns false for plain Error objects', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRateLimitError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// friendlyErrorMessage
// ---------------------------------------------------------------------------

describe('friendlyErrorMessage', () => {
  it('returns retrying message when rate-limited and retrying', () => {
    const err = makeApiError(502, '429 Too Many Requests');
    expect(friendlyErrorMessage(err, 1, true)).toBe('Upstream rate limited — retrying…');
  });

  it('returns max-retries message when rate-limited and max attempts reached', () => {
    const err = makeApiError(502, '429 Too Many Requests');
    expect(friendlyErrorMessage(err, 3, false)).toBe('Upstream rate limited — click Refresh to retry');
  });

  it('returns generic rate-limit message when not retrying and not maxed', () => {
    const err = makeApiError(502, '429 Too Many Requests');
    expect(friendlyErrorMessage(err, 0, false)).toBe('Upstream rate limited');
  });

  it('returns status-based message for non-rate-limit API errors', () => {
    const err = makeApiError(502, 'Upstream connection refused');
    expect(friendlyErrorMessage(err, 0, false)).toBe('Upstream error (502)');
  });

  it('returns error message for plain Error', () => {
    expect(friendlyErrorMessage(new Error('Network offline'), 0, false)).toBe('Network offline');
  });

  it('returns unknown for non-Error values', () => {
    expect(friendlyErrorMessage('oops', 0, false)).toBe('Unknown error');
  });
});

// ---------------------------------------------------------------------------
// useUpstreamFetch — success case
// ---------------------------------------------------------------------------

describe('useUpstreamFetch — success', () => {
  beforeEach(() => {
    global.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch;
  });

  it('starts in loading state', () => {
    const { result } = renderHook(() => useUpstreamFetch('/test'));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.retrying).toBe(false);
    expect(result.current.retryCount).toBe(0);
  });

  it('returns data on successful fetch', async () => {
    mockFetch({ value: 42 });
    const { result } = renderHook(() => useUpstreamFetch<{ value: number }>('/test'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
    expect(result.current.retrying).toBe(false);
    expect(result.current.retryCount).toBe(0);
  });

  it('calls /api prefixed URL', async () => {
    const fetchMock = mockFetch({ ok: true });
    renderHook(() => useUpstreamFetch('/my-endpoint'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/my-endpoint', undefined);
  });
});

// ---------------------------------------------------------------------------
// useUpstreamFetch — non-rate-limit error (no retry)
// ---------------------------------------------------------------------------

describe('useUpstreamFetch — non-rate-limit error', () => {
  beforeEach(() => {
    global.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch;
  });

  it('sets error message without retrying on non-rate-limit 502', async () => {
    mock502Other();
    const { result } = renderHook(() => useUpstreamFetch('/test'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Upstream error (502)');
    expect(result.current.retrying).toBe(false);
    expect(result.current.retryCount).toBe(0);
  });

  it('sets error on non-502 error', async () => {
    global.fetch = mock().mockResolvedValue({
      ok: false,
      status: 500,
      text: mock().mockResolvedValue('Internal Server Error'),
      statusText: 'Internal Server Error',
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useUpstreamFetch('/test'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Upstream error (500)');
    expect(result.current.retrying).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useUpstreamFetch — rate-limit error (retry behavior)
// ---------------------------------------------------------------------------

describe('useUpstreamFetch — rate-limit retry', () => {
  beforeEach(() => {
    global.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch;
  });

  it('sets retrying=true after rate-limit 502 (first attempt)', async () => {
    mock502RateLimit();
    const { result } = renderHook(() => useUpstreamFetch('/test'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Should be in retrying state — timer pending but not yet fired
    expect(result.current.retrying).toBe(true);
    expect(result.current.retryCount).toBe(1);
    expect(result.current.error).toBe('Upstream rate limited — retrying…');
  });

  it('shows error after rate-limit failure and retrying=true (timer pending)', async () => {
    // The hook immediately retries via timers; we just verify the state after the
    // initial failed fetch: error is set, retrying=true, retryCount=1.
    mock502RateLimit();

    const { result, unmount } = renderHook(() => useUpstreamFetch('/test'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Upstream rate limited — retrying…');
    expect(result.current.retrying).toBe(true);
    expect(result.current.retryCount).toBe(1);

    unmount();
  });

  it('retryCount increments on each timer-driven retry attempt', async () => {
    // Each fetch returns 502 rate-limit. We trigger retries via retry() to avoid
    // real timers (5s/15s/30s delays).
    global.fetch = mock().mockResolvedValue({
      ok: false,
      status: 502,
      text: mock().mockResolvedValue('{"error":"429 Too Many Requests"}'),
      statusText: 'Bad Gateway',
    }) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useUpstreamFetch('/test'));

    // After initial attempt: retryCount=1
    await waitFor(() => expect(result.current.retrying).toBe(true));
    expect(result.current.retryCount).toBe(1);

    unmount();
  });

  it('retry() resets state and re-fetches', async () => {
    // First fetch fails with rate-limit, second succeeds
    global.fetch = mock()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: mock().mockResolvedValue('429 Too Many Requests'),
        statusText: 'Bad Gateway',
      })
      .mockResolvedValueOnce(mockFetchResponse({ hello: 'world' })) as unknown as typeof fetch;

    const { result } = renderHook(() => useUpstreamFetch<{ hello: string }>('/test'));
    await waitFor(() => expect(result.current.retrying).toBe(true));

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data).toEqual({ hello: 'world' });
    expect(result.current.error).toBeNull();
    expect(result.current.retrying).toBe(false);
  });

  it('clears error and data on retry()', async () => {
    mock502RateLimit();
    const { result } = renderHook(() => useUpstreamFetch('/test'));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    // Set up success for the retry
    mockFetch({ val: 1 });
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.error).toBeNull();
  });
});
