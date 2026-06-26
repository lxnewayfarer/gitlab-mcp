import { describe, it, expect } from "vitest";
import { pendingAuthorizeStore } from "../../src/auth/pendingAuthorizeStore.js";

function fakeRedis() {
  const m = new Map<string, string>();
  return {
    async set(k: string, v: string) { m.set(k, v); },
    async get(k: string) { return m.get(k) ?? null; },
    async del(k: string) { m.delete(k); },
  } as any;
}

describe("pendingAuthorizeStore", () => {
  it("saves and takes once", async () => {
    const store = pendingAuthorizeStore(fakeRedis());
    await store.save("state_b", { clientId: "c1", redirectUri: "http://cb", clientState: "xyz", codeChallenge: "chal" });
    const first = await store.take("state_b");
    expect(first).toEqual({ clientId: "c1", redirectUri: "http://cb", clientState: "xyz", codeChallenge: "chal" });
    expect(await store.take("state_b")).toBeNull();
  });
});
