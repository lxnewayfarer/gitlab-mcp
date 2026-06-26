import { describe, it, expect } from "vitest";
import { sanitizeParams } from "../../src/mcp/sanitize.js";

describe("sanitizeParams", () => {
  it("redacts secret-like top-level keys", () => {
    const out = sanitizeParams({
      access_token: "abc",
      refreshToken: "def",
      client_secret: "ghi",
      password: "p",
      authorization: "Bearer x",
      api_key: "k1",
      "api-key": "k2",
      apiKey: "k3",
      credential: "c",
      title: "ok",
    }) as Record<string, unknown>;

    expect(out.access_token).toBe("[REDACTED]");
    expect(out.refreshToken).toBe("[REDACTED]");
    expect(out.client_secret).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.api_key).toBe("[REDACTED]");
    expect(out["api-key"]).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.credential).toBe("[REDACTED]");
    expect(out.title).toBe("ok");
  });

  it("leaves normal fields untouched", () => {
    const input = {
      project_id: 42,
      title: "Add feature",
      labels: ["a", "b"],
      merge_request_iid: 7,
    };
    expect(sanitizeParams(input)).toEqual(input);
  });

  it("redacts nested secret keys", () => {
    const out = sanitizeParams({
      project_id: 1,
      meta: { secret: "s", nested: { my_token: "t", name: "keep" } },
    }) as any;
    expect(out.project_id).toBe(1);
    expect(out.meta.secret).toBe("[REDACTED]");
    expect(out.meta.nested.my_token).toBe("[REDACTED]");
    expect(out.meta.nested.name).toBe("keep");
  });

  it("recurses into arrays", () => {
    const out = sanitizeParams({
      items: [{ password: "x", id: 1 }, { id: 2 }],
    }) as any;
    expect(out.items[0].password).toBe("[REDACTED]");
    expect(out.items[0].id).toBe(1);
    expect(out.items[1].id).toBe(2);
  });

  it("passes primitives and null through unchanged", () => {
    expect(sanitizeParams(null)).toBeNull();
    expect(sanitizeParams(42)).toBe(42);
    expect(sanitizeParams("hello")).toBe("hello");
    expect(sanitizeParams(true)).toBe(true);
    expect(sanitizeParams(undefined)).toBeUndefined();
  });
});
