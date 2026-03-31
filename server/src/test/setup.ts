/// <reference path="../../node_modules/@testing-library/jest-dom/types/bun.d.ts" />

// ---------------------------------------------------------------------------
// DOM environment — register happy-dom globals before everything else
// (bun 1.3.9: bunfig environment setting unreliable; use GlobalRegistrator)
// After registering, restore the native fetch so backend tests still work.
// ---------------------------------------------------------------------------
const _nativeFetch = globalThis.fetch;
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/', width: 1024, height: 768 });
// Restore native fetch — happy-dom's fetch enforces CORS which breaks backend tests
globalThis.fetch = _nativeFetch;

// ---------------------------------------------------------------------------
// jest-dom matchers (extends expect with toBeInTheDocument etc.)
// ---------------------------------------------------------------------------
import '@testing-library/jest-dom';
import { mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// localStorage mock (reset state between tests)
// ---------------------------------------------------------------------------
const localStorageData: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStorageData[key] ?? null,
  setItem: (key: string, value: string) => { localStorageData[key] = value; },
  removeItem: (key: string) => { delete localStorageData[key]; },
  clear: () => { for (const k in localStorageData) delete localStorageData[k]; },
  get length() { return Object.keys(localStorageData).length; },
  key: (index: number) => Object.keys(localStorageData)[index] ?? null,
};
try {
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
} catch {
  (globalThis as unknown as Record<string, unknown>)['localStorage'] = localStorageMock;
}

// ---------------------------------------------------------------------------
// Global reset between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  mock.restore();
  // Reset document body between tests
  if (typeof document !== 'undefined' && document.body) {
    document.body.innerHTML = '';
  }
});

// ---------------------------------------------------------------------------
// Mock EventSource (happy-dom doesn't provide one)
// ---------------------------------------------------------------------------
export class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState: number = 0; // CONNECTING
  listeners: Record<string, ((e: MessageEvent | Event) => void)[]> = {};
  onerror: ((e: Event) => void) | null = null;

  // Expose for test control
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (e: MessageEvent | Event) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (e: MessageEvent | Event) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  /** Test helper: emit an open event */
  simulateOpen() {
    this.readyState = MockEventSource.OPEN;
    const listeners = this.listeners['open'] ?? [];
    for (const l of listeners) l(new Event('open'));
  }

  /** Test helper: emit a named message event */
  simulateMessage(eventType: string, data: unknown) {
    const listeners = this.listeners[eventType] ?? [];
    const event = Object.assign(new MessageEvent(eventType, { data: JSON.stringify(data) }));
    for (const l of listeners) l(event);
  }

  /** Test helper: simulate connection error */
  simulateError() {
    this.readyState = MockEventSource.CLOSED;
    if (this.onerror) this.onerror(new Event('error'));
  }
}

// Register globally — the hook uses `new EventSource(...)` without importing
(globalThis as unknown as Record<string, unknown>)['EventSource'] = MockEventSource;

// Cleanup between tests
beforeEach(() => {
  MockEventSource.instances = [];
});
