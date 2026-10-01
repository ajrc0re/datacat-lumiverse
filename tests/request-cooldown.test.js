import { expect, test } from "bun:test";
import { createRequestCooldown, retryAfterMilliseconds } from "../src/request-cooldown.js";

test("Retry-After accepts seconds and HTTP dates, with a fallback for missing or invalid values", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  expect(retryAfterMilliseconds({ "rEtRy-AfTeR": "3600" }, now)).toBe(3_600_000);
  expect(retryAfterMilliseconds({ "Retry-After": "Thu, 01 Oct 2026 12:01:00 GMT" }, now)).toBe(60_000);
  expect(retryAfterMilliseconds({ "Retry-After": "0" }, now)).toBe(1000);
  expect(retryAfterMilliseconds({ "Retry-After": "-10" }, 1000)).toBe(60_000);
  for (const value of [null, "", "invalid", "-10", "Infinity"]) {
    expect(retryAfterMilliseconds({ "Retry-After": value }, now)).toBe(60_000);
  }
});

test("a rate-limit cooldown persists across recreation, counts down, and permits requests at expiry", async () => {
  let timestamp = 1_000_000;
  let record = null;
  const options = { load: async () => record, save: async (next) => { record = next; }, now: () => timestamp };
  const guard = createRequestCooldown(options);
  expect(await guard.blockedResponse()).toBeNull();
  await guard.observe({ status: 429, headers: { "retry-after": "3600" } });
  expect(record.expiresAt).toBe(timestamp + 3_600_000);
  timestamp += 600_000;
  const restarted = createRequestCooldown(options);
  expect((await restarted.blockedResponse()).headers["Retry-After"]).toBe("3000");
  await restarted.observe({ status: 200 });
  await restarted.observe({ status: 429, headers: { "Retry-After": "60" } });
  expect(record.expiresAt).toBe(4_600_000);
  timestamp = record.expiresAt;
  expect(await restarted.blockedResponse()).toBeNull();
});

test("concurrent rate-limit responses cannot shorten the persisted deadline", async () => {
  let record;
  const guard = createRequestCooldown({ load: async () => null, save: async (next) => { record = next; }, now: () => 1_000_000 });
  await Promise.all([
    guard.observe({ status: 429, headers: { "Retry-After": "3600" } }),
    guard.observe({ status: 429, headers: { "Retry-After": "60" } }),
  ]);
  expect(record.expiresAt).toBe(4_600_000);
});

test("the backend stops outgoing requests for all accounts and restores the guard after a worker restart", async () => {
  let receiver;
  let calls = 0;
  let record;
  const replies = [];
  globalThis.spindle = {
    on() {},
    onFrontendMessage(fn) { receiver = fn; },
    sendToFrontend(message) { replies.push(message); },
    enclave: { async get() { return null; }, async put() {} },
    storage: { async getJson() { return record; }, async setJson(_path, next) { record = next; } },
    async cors() {
      calls += 1;
      return { status: 429, headers: { "Retry-After": "3600" }, body: JSON.stringify({ error: "RATE_LIMITED" }) };
    },
  };
  try {
    await import("../src/backend.js?cooldown-test=first");
    const request = async (path, userId) => {
      await receiver({ type: "datacat_api_request", requestId: String(replies.length), request: { path } }, userId);
      expect(replies.at(-1).type).toBe("datacat_api_result");
      expect(replies.at(-1).response.status).toBe(429);
    };
    await request("/characters?limit=24", "first-account");
    await request("/tags", "second-account");
    await request("/characters?search=test", "first-account");
    await request("/characters/00000000-0000-4000-8000-000000000001/card", "second-account");
    expect(calls).toBe(1);
    expect(record.expiresAt).toBeGreaterThan(Date.now());
    await import("../src/backend.js?cooldown-test=restarted");
    await request("/fresh", "first-account");
    expect(calls).toBe(1);
    expect(Number(replies.at(-1).response.headers["Retry-After"])).toBeGreaterThan(3590);
  } finally {
    delete globalThis.spindle;
  }
});
