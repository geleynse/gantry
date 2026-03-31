import { describe, it, expect, mock, beforeEach } from "bun:test";
import { registerAccount } from "./game-registration.js";

describe("game-registration", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("successfully registers an account", async () => {
    const mockResponse = {
      player_id: "p123",
      password: "secret-password-256",
    };

    globalThis.fetch = mock(() => 
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    ) as any;

    const result = await registerAccount("testuser", "Solarian", "CODE123");

    expect(result).toEqual({
      playerId: "p123",
      password: "secret-password-256",
    });
    
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("throws error on registration failure", async () => {
    globalThis.fetch = mock(() => 
      Promise.resolve(new Response(JSON.stringify({ error: "Invalid code" }), { status: 400 }))
    ) as any;

    await expect(registerAccount("testuser", "Solarian", "WRONG")).rejects.toThrow("Invalid code");
  });

  it("throws error on missing data in response", async () => {
    globalThis.fetch = mock(() => 
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
    ) as any;

    await expect(registerAccount("testuser", "Solarian", "CODE123")).rejects.toThrow("Invalid response");
  });
});
