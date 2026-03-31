/**
 * LifecycleManager — tracks setInterval handles for clean shutdown.
 *
 * Prevents timer leaks when the proxy is recreated. All registered timers
 * are cleared via stopAll(), which is called during graceful shutdown.
 */

export class LifecycleManager {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();

  /** Register a named timer so it can be stopped by stopAll(). Clears any existing timer with the same name. */
  register(name: string, timer: ReturnType<typeof setInterval>): void {
    const existing = this.timers.get(name);
    if (existing) clearInterval(existing);
    this.timers.set(name, timer);
  }

  /** Unregister a timer (e.g. if manually stopped before shutdown). */
  unregister(name: string): void {
    this.timers.delete(name);
  }

  /** Clear all registered timers and empty the registry. */
  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /** Return names of all registered timers (for debugging). */
  getRegistered(): string[] {
    return [...this.timers.keys()];
  }
}
