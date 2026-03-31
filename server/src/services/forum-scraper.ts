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
  private forumUrl: string | undefined;

  constructor(forumUrl?: string) {
    this.forumUrl = forumUrl;
    if (!forumUrl) {
      log.debug("Forum service initialized without URL — running in stub mode");
    } else {
      log.info("Forum service initialized", { url: forumUrl });
    }
  }

  isConfigured(): boolean {
    return !!this.forumUrl;
  }

  async getLatestPosts(_category?: string): Promise<ForumPost[]> {
    if (!this.forumUrl) {
      // TODO: when forumUrl is set, fetch from `${this.forumUrl}/posts?category=${category}`
      return [];
    }
    // TODO: implement actual HTTP fetch and parse
    log.warn("Forum URL is set but live scraping not yet implemented");
    return [];
  }

  async searchPosts(_query: string): Promise<ForumPost[]> {
    if (!this.forumUrl) {
      // TODO: when forumUrl is set, fetch from `${this.forumUrl}/search?q=${encodeURIComponent(query)}`
      return [];
    }
    // TODO: implement actual HTTP fetch and parse
    log.warn("Forum URL is set but live scraping not yet implemented");
    return [];
  }

  async getGameUpdates(): Promise<ForumPost[]> {
    if (!this.forumUrl) {
      // TODO: when forumUrl is set, fetch from `${this.forumUrl}/posts?category=updates`
      return [];
    }
    // TODO: implement actual HTTP fetch and parse
    log.warn("Forum URL is set but live scraping not yet implemented");
    return [];
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
  private inner: ForumService;
  private latestPostsCache = new Map<string, CacheEntry<ForumPost[]>>();
  private searchCache = new Map<string, CacheEntry<ForumPost[]>>();
  private updatesCache: CacheEntry<ForumPost[]> | null = null;

  constructor(inner: ForumService) {
    this.inner = inner;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  async getLatestPosts(category?: string): Promise<ForumPost[]> {
    const key = category ?? "__all__";
    const cached = this.latestPostsCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    const data = await this.inner.getLatestPosts(category);
    this.latestPostsCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  }

  async searchPosts(query: string): Promise<ForumPost[]> {
    const key = query.toLowerCase().trim();
    const cached = this.searchCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    const data = await this.inner.searchPosts(query);
    this.searchCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  }

  async getGameUpdates(): Promise<ForumPost[]> {
    if (this.updatesCache && Date.now() - this.updatesCache.fetchedAt < CACHE_TTL_MS) {
      return this.updatesCache.data;
    }
    const data = await this.inner.getGameUpdates();
    this.updatesCache = { data, fetchedAt: Date.now() };
    return data;
  }

  /** Invalidate all caches (e.g., for testing or forced refresh). */
  clearCache(): void {
    this.latestPostsCache.clear();
    this.searchCache.clear();
    this.updatesCache = null;
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
