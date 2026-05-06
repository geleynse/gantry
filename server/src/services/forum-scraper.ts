/**
 * Forum Scraper Service — reads game forums for intel that can inform agent decisions.
 *
 * The ForumService interface defines the contract. The stub implementation returns
 * empty data with TODO comments for the real forum URL.
 *
 * Configuration: set forumUrl in fleet-config.json to enable live scraping.
 * Without a URL, the stub returns empty arrays so the dashboard shows a
 * "No forum configured" state gracefully.
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("forum-scraper");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForumPost {
  id: string;
  title: string;
  author: string;
  content: string;
  category: string;
  timestamp: string;
  tags: string[];
  url?: string;
}

// ---------------------------------------------------------------------------
// ForumService interface
// ---------------------------------------------------------------------------

export interface ForumService {
  /** Get the latest posts, optionally filtered by category. */
  getLatestPosts(category?: string): Promise<ForumPost[]>;

  /** Search posts by keyword. */
  searchPosts(query: string): Promise<ForumPost[]>;

  /** Get game update/patch note posts. */
  getGameUpdates(): Promise<ForumPost[]>;

  /** True when the service is configured with a real forum URL. */
  isConfigured(): boolean;
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

/**
 * StubForumService — returns empty data.
 * Replace with a real implementation once forum URL and auth are available.
 *
 * TODO: implement real scraping against the game forum URL when available.
 * Suggested approach:
 *   - Use Bun's fetch() to GET `${forumUrl}/api/posts?category=${category}`
 *   - Parse JSON (or HTML with a DOM parser) into ForumPost objects
 *   - Cache results in memory with a TTL (e.g. 15 minutes) to avoid hammering the forum
 *   - Handle rate limiting / auth tokens from fleet-config.json
 */
export class StubForumService implements ForumService {
  constructor(private forumUrl?: string) {
    if (forumUrl) {
      log.info("Forum service initialized", { url: forumUrl });
    } else {
      log.debug("Forum service initialized without URL — running in stub mode");
    }
  }

  isConfigured(): boolean {
    return !!this.forumUrl;
  }

  private async stubFetch(): Promise<ForumPost[]> {
    if (this.forumUrl) {
      log.warn("Forum URL is set but live scraping not yet implemented");
    }
    return [];
  }

  getLatestPosts(_category?: string): Promise<ForumPost[]> {
    return this.stubFetch();
  }

  searchPosts(_query: string): Promise<ForumPost[]> {
    return this.stubFetch();
  }

  getGameUpdates(): Promise<ForumPost[]> {
    return this.stubFetch();
  }
}

// ---------------------------------------------------------------------------
// Cache wrapper
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * CachedForumService — wraps another ForumService with in-memory caching.
 * Reduces repeated requests during a single server uptime.
 */
export class CachedForumService implements ForumService {
  private cache = new Map<string, CacheEntry<ForumPost[]>>();

  constructor(private inner: ForumService) {}

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  private async memoize(key: string, fetch: () => Promise<ForumPost[]>): Promise<ForumPost[]> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    const data = await fetch();
    this.cache.set(key, { data, fetchedAt: Date.now() });
    return data;
  }

  getLatestPosts(category?: string): Promise<ForumPost[]> {
    return this.memoize(`latest:${category ?? "__all__"}`, () => this.inner.getLatestPosts(category));
  }

  searchPosts(query: string): Promise<ForumPost[]> {
    return this.memoize(`search:${query.toLowerCase().trim()}`, () => this.inner.searchPosts(query));
  }

  getGameUpdates(): Promise<ForumPost[]> {
    return this.memoize("updates", () => this.inner.getGameUpdates());
  }

  /** Invalidate all caches (e.g., for testing or forced refresh). */
  clearCache(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ForumService configured from the given forumUrl.
 * Returns a cached wrapper around a stub implementation.
 * When forumUrl is set, the stub logs warnings for unimplemented methods.
 */
export function createForumService(forumUrl?: string): ForumService {
  const stub = new StubForumService(forumUrl);
  return new CachedForumService(stub);
}
