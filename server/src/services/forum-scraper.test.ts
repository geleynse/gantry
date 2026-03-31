/**
 * Tests for the Forum Scraper Service (Task #29).
 * Tests the interface, stub implementation, cached wrapper, and factory.
 */

import { describe, it, expect } from "bun:test";
import {
  StubForumService,
  CachedForumService,
  createForumService,
  type ForumService,
  type ForumPost,
} from "./forum-scraper.js";

// ---------------------------------------------------------------------------
// StubForumService — unconfigured (no URL)
// ---------------------------------------------------------------------------

describe("StubForumService — unconfigured", () => {
  const stub = new StubForumService();

  it("isConfigured returns false when no URL", () => {
    expect(stub.isConfigured()).toBe(false);
  });

  it("getLatestPosts returns empty array", async () => {
    const posts = await stub.getLatestPosts();
    expect(posts).toEqual([]);
  });

  it("getLatestPosts returns empty array with category filter", async () => {
    const posts = await stub.getLatestPosts("updates");
    expect(posts).toEqual([]);
  });

  it("searchPosts returns empty array", async () => {
    const posts = await stub.searchPosts("pirate nerf");
    expect(posts).toEqual([]);
  });

  it("getGameUpdates returns empty array", async () => {
    const posts = await stub.getGameUpdates();
    expect(posts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// StubForumService — configured (with URL, still stub)
// ---------------------------------------------------------------------------

describe("StubForumService — configured with URL", () => {
  const stub = new StubForumService("https://forum.spacemolt.com");

  it("isConfigured returns true when URL is set", () => {
    expect(stub.isConfigured()).toBe(true);
  });

  it("getLatestPosts still returns empty (not implemented)", async () => {
    // Stub logs a warning but doesn't throw
    const posts = await stub.getLatestPosts();
    expect(Array.isArray(posts)).toBe(true);
  });

  it("searchPosts still returns empty (not implemented)", async () => {
    const posts = await stub.searchPosts("pvp balance");
    expect(Array.isArray(posts)).toBe(true);
  });

  it("getGameUpdates still returns empty (not implemented)", async () => {
    const posts = await stub.getGameUpdates();
    expect(Array.isArray(posts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ForumPost shape validation
// ---------------------------------------------------------------------------

describe("ForumPost type shape", () => {
  it("can construct a valid ForumPost object", () => {
    const post: ForumPost = {
      id: "post-123",
      title: "Patch v0.25 — new ship class",
      author: "devteam",
      content: "We added a new cruiser class today...",
      category: "updates",
      timestamp: "2026-03-22T10:00:00Z",
      tags: ["patch", "ship", "balance"],
      url: "https://forum.spacemolt.com/posts/123",
    };
    expect(post.id).toBe("post-123");
    expect(post.tags).toHaveLength(3);
    expect(post.url).toContain("forum");
  });

  it("ForumPost url is optional", () => {
    const post: ForumPost = {
      id: "post-456",
      title: "Tips for new traders",
      author: "veteran_player",
      content: "Trade tip: always check market first...",
      category: "guides",
      timestamp: "2026-03-21T08:00:00Z",
      tags: ["guide", "trading"],
    };
    expect(post.url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CachedForumService — caching behavior
// ---------------------------------------------------------------------------

/**
 * Mock forum service that counts calls and returns test data.
 */
class MockForumService implements ForumService {
  callCounts = { getLatestPosts: 0, searchPosts: 0, getGameUpdates: 0 };
  posts: ForumPost[] = [
    {
      id: "mock-1",
      title: "Mock Post",
      author: "mock-author",
      content: "Mock content",
      category: "general",
      timestamp: new Date().toISOString(),
      tags: ["mock"],
    },
  ];

  isConfigured() { return true; }

  async getLatestPosts(_category?: string) {
    this.callCounts.getLatestPosts++;
    return this.posts;
  }

  async searchPosts(_query: string) {
    this.callCounts.searchPosts++;
    return this.posts;
  }

  async getGameUpdates() {
    this.callCounts.getGameUpdates++;
    return this.posts;
  }
}

describe("CachedForumService", () => {
  it("isConfigured delegates to inner service", () => {
    const inner = new MockForumService();
    const cached = new CachedForumService(inner);
    expect(cached.isConfigured()).toBe(true);

    const unconfigured = new CachedForumService(new StubForumService());
    expect(unconfigured.isConfigured()).toBe(false);
  });

  it("caches getLatestPosts result on second call", async () => {
    const inner = new MockForumService();
    const cached = new CachedForumService(inner);

    await cached.getLatestPosts();
    await cached.getLatestPosts(); // second call — should hit cache
    expect(inner.callCounts.getLatestPosts).toBe(1);
  });

  it("caches per-category for getLatestPosts", async () => {
    const inner = new MockForumService();
    const cached = new CachedForumService(inner);

    await cached.getLatestPosts("updates");
    await cached.getLatestPosts("general"); // different category — fresh fetch
    await cached.getLatestPosts("updates"); // same as first — should hit cache
    expect(inner.callCounts.getLatestPosts).toBe(2);
  });

  it("caches searchPosts result", async () => {
    const inner = new MockForumService();
    const cached = new CachedForumService(inner);

    await cached.searchPosts("pirate");
    await cached.searchPosts("pirate"); // same query — hit cache
    expect(inner.callCounts.searchPosts).toBe(1);
  });

  it("different search queries are cached separately", async () => {
    const inner = new MockForumService();
    const cached = new CachedForumService(inner);

    await cached.searchPosts("pirate");
    await cached.searchPosts("trade route"); // different query — fresh fetch
    expect(inner.callCounts.searchPosts).toBe(2);
  });

  it("caches getGameUpdates result", async () => {
    const inner = new MockForumService();
    const cached = new CachedForumService(inner);

    await cached.getGameUpdates();
    await cached.getGameUpdates(); // should hit cache
    expect(inner.callCounts.getGameUpdates).toBe(1);
  });

  it("clearCache forces fresh fetch on next call", async () => {
    const inner = new MockForumService();
    const cached = new CachedForumService(inner);

    await cached.getLatestPosts();
    cached.clearCache();
    await cached.getLatestPosts(); // should fetch again after clear
    expect(inner.callCounts.getLatestPosts).toBe(2);
  });

  it("returns actual data from inner service", async () => {
    const inner = new MockForumService();
    const cached = new CachedForumService(inner);

    const posts = await cached.getLatestPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe("mock-1");
  });
});

// ---------------------------------------------------------------------------
// createForumService factory
// ---------------------------------------------------------------------------

describe("createForumService factory", () => {
  it("returns a ForumService instance", () => {
    const service = createForumService();
    expect(typeof service.getLatestPosts).toBe("function");
    expect(typeof service.searchPosts).toBe("function");
    expect(typeof service.getGameUpdates).toBe("function");
    expect(typeof service.isConfigured).toBe("function");
  });

  it("unconfigured service returns isConfigured=false", () => {
    const service = createForumService();
    expect(service.isConfigured()).toBe(false);
  });

  it("configured service returns isConfigured=true", () => {
    const service = createForumService("https://forum.spacemolt.com");
    expect(service.isConfigured()).toBe(true);
  });

  it("configured service returns empty arrays (stub, not implemented)", async () => {
    const service = createForumService("https://forum.spacemolt.com");
    const posts = await service.getLatestPosts();
    expect(Array.isArray(posts)).toBe(true);
  });
});
