import { describe, it, expect, beforeEach } from "bun:test";
import request from "supertest";
import express from "express";
import { createAccountsRouter } from "./accounts.js";

function makeApp(role: "admin" | "viewer", poolEnabled = false) {
  const mockPool = poolEnabled
    ? {
        listAccounts: () => [{ username: "u1", assignedTo: "agent-1", status: "in_use" }],
        getPoolConfig: () => ({ autoAssign: true }),
        assignAccountTo: (_agent: string, _username: string) => true,
        releaseAccount: (_agent: string) => {},
      }
    : null;

  const mockSessions = {
    getPoolInstance: () => mockPool,
  } as any;

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.auth = { role, identity: "test-user" };
    next();
  });
  app.use("/api/accounts", createAccountsRouter(mockSessions, poolEnabled ? "/fake/pool.json" : null));
  return app;
}

describe("accounts-routes — admin checks", () => {
  it("GET /api/accounts returns 403 for viewer role", async () => {
    const app = makeApp("viewer");
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/accounts returns 200 for admin with pool disabled", async () => {
    const app = makeApp("admin", false);
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.accounts).toHaveLength(0);
  });

  it("GET /api/accounts returns account list for admin with pool enabled", async () => {
    const app = makeApp("admin", true);
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].username).toBe("u1");
    // passwords must not be exposed (mock doesn't include them, but verify shape)
    expect(res.body.accounts[0].password).toBeUndefined();
  });
});
