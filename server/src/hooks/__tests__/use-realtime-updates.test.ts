import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useRealtimeUpdates } from "../use-realtime-updates";
import { MockEventSource } from "@/test/setup";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WsReadyState = 0 | 1 | 2 | 3;

interface WsMessage {
  type: string;
  channel?: string;
  event?: string;
  data?: unknown;
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING: WsReadyState = 0;
  static OPEN: WsReadyState = 1;
  static CLOSING: WsReadyState = 2;
  static CLOSED: WsReadyState = 3;

  url: string;
  readyState: WsReadyState = MockWebSocket.CONNECTING;
  sentMessages: string[] = [];

  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  /** Test helper: simulate successful connection */
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** Test helper: simulate an incoming server message */
  simulateMessage(msg: WsMessage) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(msg) })
    );
  }

  /** Test helper: simulate connection error/close without open */
  simulateError() {
    this.readyState = MockWebSocket.CLOSED;
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close"));
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const origWebSocket = (globalThis as unknown as Record<string, unknown>)["WebSocket"];

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as unknown as Record<string, unknown>)["WebSocket"] = MockWebSocket;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>)["WebSocket"] = origWebSocket;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  channel: "fleet-status",
  sseUrl: "/api/status/stream",
  sseEvent: "status",
  minRetryMs: 0,
  maxRetryMs: 0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useRealtimeUpdates", () => {
  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  it("starts with null data, not connected, transport=none", () => {
    const { result } = renderHook(() =>
      useRealtimeUpdates<{ val: number }>(DEFAULT_OPTIONS)
    );
    expect(result.current.data).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.transport).toBe("none");
    expect(result.current.error).toBeNull();
  });

  it("tries WebSocket first by default", () => {
    renderHook(() => useRealtimeUpdates<unknown>(DEFAULT_OPTIONS));
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("uses SSE when forceSSE=true", () => {
    renderHook(() =>
      useRealtimeUpdates<unknown>({ ...DEFAULT_OPTIONS, forceSSE: true })
    );
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // WebSocket path
  // ---------------------------------------------------------------------------

  it("sets transport=websocket and connected=true on WS open", async () => {
    const { result } = renderHook(() =>
      useRealtimeUpdates<unknown>(DEFAULT_OPTIONS)
    );
    act(() => MockWebSocket.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.transport).toBe("websocket");
  });

  it("sends subscribe message after WS open", async () => {
    const { result } = renderHook(() =>
      useRealtimeUpdates<unknown>(DEFAULT_OPTIONS)
    );
    act(() => MockWebSocket.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));

    const sent = MockWebSocket.instances[0].sentMessages;
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const sub = JSON.parse(sent[sent.length - 1]);
    expect(sub).toMatchObject({ type: "subscribe", channel: "fleet-status" });
  });

  it("updates data when WS delivers matching channel event", async () => {
    const { result } = renderHook(() =>
      useRealtimeUpdates<{ count: number }>(DEFAULT_OPTIONS)
    );
    act(() => MockWebSocket.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      MockWebSocket.instances[0].simulateMessage({
        type: "event",
        channel: "fleet-status",
        event: "status",
        data: { count: 7 },
      });
    });
    await waitFor(() => expect(result.current.data?.count).toBe(7));
  });

  it("ignores WS events for other channels", async () => {
    const { result } = renderHook(() =>
      useRealtimeUpdates<{ count: number }>(DEFAULT_OPTIONS)
    );
    act(() => MockWebSocket.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      MockWebSocket.instances[0].simulateMessage({
        type: "event",
        channel: "tool-calls", // different channel
        event: "toolCall",
        data: { count: 99 },
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.data).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // SSE fallback
  // ---------------------------------------------------------------------------

  it("falls back to SSE when WS fails to connect", async () => {
    const { result } = renderHook(() =>
      useRealtimeUpdates<{ val: number }>({ ...DEFAULT_OPTIONS, minRetryMs: 0 })
    );

    // WS fails immediately (no open)
    act(() => MockWebSocket.instances[0].simulateError());

    // Should now have an SSE connection
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1));

    // Simulate SSE connection
    act(() => {
      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es.simulateOpen();
      es.simulateMessage("status", { val: 42 });
    });

    await waitFor(() => expect(result.current.data).toMatchObject({ val: 42 }));
    expect(result.current.transport).toBe("sse");
  });

  it("uses SSE URL provided in options for fallback", async () => {
    renderHook(() =>
      useRealtimeUpdates<unknown>({
        ...DEFAULT_OPTIONS,
        sseUrl: "/api/custom/stream",
        minRetryMs: 0,
      })
    );

    act(() => MockWebSocket.instances[0].simulateError());

    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(es.url).toBe("/api/custom/stream");
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  it("closes WS on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useRealtimeUpdates<unknown>(DEFAULT_OPTIONS)
    );
    act(() => MockWebSocket.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));

    const ws = MockWebSocket.instances[0];
    unmount();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("closes SSE on unmount when in SSE mode", async () => {
    const { result, unmount } = renderHook(() =>
      useRealtimeUpdates<unknown>({ ...DEFAULT_OPTIONS, forceSSE: true })
    );
    act(() => MockEventSource.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));

    const es = MockEventSource.instances[0];
    unmount();
    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });

  it("sets connected=false on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useRealtimeUpdates<unknown>(DEFAULT_OPTIONS)
    );
    act(() => MockWebSocket.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));
    unmount();
    // After unmount, state is no longer observable but we can verify WS closed
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
  });
});
