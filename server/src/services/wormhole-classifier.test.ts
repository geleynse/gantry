import { describe, it, expect } from "bun:test";
import { classifyConnections, getWormholes, type SystemCoords } from "./wormhole-classifier.js";

describe("classifyConnections", () => {
  const systems: SystemCoords[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 1, y: 0 },
    { id: "c", x: 2, y: 0 },
    { id: "d", x: 3, y: 0 },
    { id: "e", x: 100, y: 0 }, // far away — wormhole candidate
  ];

  it("returns empty map for empty connections", () => {
    expect(classifyConnections(systems, []).size).toBe(0);
  });

  it("classifies all short connections as jump", () => {
    const connections: Array<[string, string]> = [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ];
    const result = classifyConnections(systems, connections);
    expect(result.get("a:b")).toBe("jump");
    expect(result.get("b:c")).toBe("jump");
    expect(result.get("c:d")).toBe("jump");
  });

  it("classifies long connection as wormhole", () => {
    // Need enough normal connections so the outlier exceeds mean + 2.5*stddev
    // With 10 connections at distance 1 and 1 at distance 100:
    // mean ~ 10, stdDev ~ 29, threshold ~ 83 → 100 > 83 = wormhole
    const denseSystems: SystemCoords[] = [
      { id: "s0", x: 0, y: 0 },
      { id: "s1", x: 1, y: 0 },
      { id: "s2", x: 2, y: 0 },
      { id: "s3", x: 3, y: 0 },
      { id: "s4", x: 4, y: 0 },
      { id: "s5", x: 5, y: 0 },
      { id: "s6", x: 6, y: 0 },
      { id: "s7", x: 7, y: 0 },
      { id: "s8", x: 8, y: 0 },
      { id: "s9", x: 9, y: 0 },
      { id: "s10", x: 10, y: 0 },
      { id: "far", x: 500, y: 0 }, // very far
    ];
    const connections: Array<[string, string]> = [];
    // 10 normal connections (distance ~1 each)
    for (let i = 0; i < 10; i++) {
      connections.push([`s${i}`, `s${i + 1}`]);
    }
    // 1 wormhole connection
    connections.push(["s0", "far"]);

    const result = classifyConnections(denseSystems, connections);
    expect(result.get("far:s0")).toBe("wormhole");
    expect(result.get("s0:s1")).toBe("jump");
  });

  it("sorts keys alphabetically", () => {
    const connections: Array<[string, string]> = [["b", "a"]];
    const result = classifyConnections(systems, connections);
    expect(result.has("a:b")).toBe(true);
    expect(result.has("b:a")).toBe(false);
  });

  it("handles missing system coords gracefully", () => {
    const connections: Array<[string, string]> = [
      ["a", "b"],
      ["a", "unknown"],
    ];
    const result = classifyConnections(systems, connections);
    expect(result.has("a:b")).toBe(true);
    expect(result.has("a:unknown")).toBe(false);
  });

  it("single connection is classified as jump (no variance)", () => {
    const connections: Array<[string, string]> = [["a", "b"]];
    const result = classifyConnections(systems, connections);
    // With 1 connection, stdDev=0, threshold=mean, dist=mean, not > threshold
    expect(result.get("a:b")).toBe("jump");
  });

  it("all equal distances are classified as jump", () => {
    const eqSystems: SystemCoords[] = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
      { id: "c", x: 20, y: 0 },
      { id: "d", x: 30, y: 0 },
    ];
    const connections: Array<[string, string]> = [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ];
    const result = classifyConnections(eqSystems, connections);
    for (const [, type] of result) {
      expect(type).toBe("jump");
    }
  });

  it("respects custom stdDevThreshold", () => {
    // With threshold=0, anything above mean is a wormhole
    const mixedSystems: SystemCoords[] = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 1, y: 0 },
      { id: "c", x: 3, y: 0 }, // distance a->b=1, b->c=2
    ];
    const connections: Array<[string, string]> = [
      ["a", "b"],
      ["b", "c"],
    ];
    // mean=1.5, stdDev=0.5. threshold at 0 stddev = 1.5
    // a->b dist=1 (< 1.5 = jump), b->c dist=2 (> 1.5 = wormhole)
    const result = classifyConnections(mixedSystems, connections, 0);
    expect(result.get("a:b")).toBe("jump");
    expect(result.get("b:c")).toBe("wormhole");
  });
});

describe("getWormholes", () => {
  it("returns empty array when no wormholes", () => {
    const map = new Map<string, "jump" | "wormhole">();
    map.set("a:b", "jump");
    map.set("b:c", "jump");
    expect(getWormholes(map)).toEqual([]);
  });

  it("returns only wormhole pairs", () => {
    const map = new Map<string, "jump" | "wormhole">();
    map.set("a:b", "jump");
    map.set("b:c", "wormhole");
    map.set("c:d", "jump");
    map.set("d:e", "wormhole");
    const wormholes = getWormholes(map);
    expect(wormholes).toHaveLength(2);
    expect(wormholes).toContainEqual({ systemA: "b", systemB: "c" });
    expect(wormholes).toContainEqual({ systemA: "d", systemB: "e" });
  });
});
