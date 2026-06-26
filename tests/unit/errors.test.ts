import { describe, it, expect } from "vitest";
import { mapError, AppError, GitLabApiError } from "../../src/middleware/errors.js";

describe("mapError", () => {
  it("passes AppError kind/message through", () => {
    const e = new AppError("forbidden", "nope");
    expect(mapError(e)).toEqual({ kind: "forbidden", message: "nope" });
  });

  it("maps GitLabApiError 401 -> token_expired", () => {
    const m = mapError(new GitLabApiError(401, "unauthorized"));
    expect(m.kind).toBe("token_expired");
    expect(m.message).toMatch(/401/);
  });

  it("maps 403 -> forbidden", () => {
    expect(mapError(new GitLabApiError(403, "x")).kind).toBe("forbidden");
  });

  it("maps 404 -> not_found", () => {
    expect(mapError(new GitLabApiError(404, "x")).kind).toBe("not_found");
  });

  it("maps 429 -> rate_limited and includes retryAfter", () => {
    const m = mapError(new GitLabApiError(429, "slow down", 17));
    expect(m.kind).toBe("rate_limited");
    expect(m.message).toMatch(/17s/);
  });

  it("maps 429 without retryAfter to a generic retry message", () => {
    const m = mapError(new GitLabApiError(429, "slow down"));
    expect(m.kind).toBe("rate_limited");
    expect(m.message).toMatch(/retry shortly/i);
  });

  it("maps 500 -> upstream_unavailable", () => {
    expect(mapError(new GitLabApiError(500, "boom")).kind).toBe("upstream_unavailable");
    expect(mapError(new GitLabApiError(503, "boom")).kind).toBe("upstream_unavailable");
  });

  it("maps other 4xx -> bad_request and includes message", () => {
    const m = mapError(new GitLabApiError(422, "validation failed"));
    expect(m.kind).toBe("bad_request");
    expect(m.message).toMatch(/422/);
    expect(m.message).toMatch(/validation failed/);
  });

  it("maps network 'fetch failed' Error -> upstream_unavailable", () => {
    expect(mapError(new Error("fetch failed")).kind).toBe("upstream_unavailable");
    expect(mapError(new Error("connect ECONNREFUSED")).kind).toBe("upstream_unavailable");
  });

  it("maps unknown Error -> internal with its message", () => {
    const m = mapError(new Error("weird"));
    expect(m.kind).toBe("internal");
    expect(m.message).toBe("weird");
  });

  it("maps non-Error throw -> internal generic", () => {
    const m = mapError("string thrown");
    expect(m.kind).toBe("internal");
    expect(m.message).toMatch(/unexpected/i);
  });
});
