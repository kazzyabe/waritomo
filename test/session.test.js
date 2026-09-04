import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSessionToken,
  getSessionSecret,
  parseCookies,
  verifySessionToken,
} from "../src/session.js";

test("session token round-trips signed payload", () => {
  const token = createSessionToken(
    { userId: "usr_1", lineUserId: "U123" },
    { secret: "test-secret", now: 100, ttlSeconds: 60 },
  );
  const payload = verifySessionToken(token, { secret: "test-secret", now: 120 });

  assert.equal(payload.userId, "usr_1");
  assert.equal(payload.lineUserId, "U123");
});

test("session token rejects tampering", () => {
  const token = createSessionToken(
    { userId: "usr_1", lineUserId: "U123" },
    { secret: "test-secret", now: 100, ttlSeconds: 60 },
  );
  const [payload, signature] = token.split(".");
  const tampered = `${payload}.${signature.slice(0, -1)}x`;

  assert.equal(verifySessionToken(tampered, { secret: "test-secret", now: 120 }), null);
});

test("session token expires", () => {
  const token = createSessionToken(
    { userId: "usr_1", lineUserId: "U123" },
    { secret: "test-secret", now: 100, ttlSeconds: 60 },
  );

  assert.equal(verifySessionToken(token, { secret: "test-secret", now: 161 }), null);
});

test("parses cookie header", () => {
  assert.deepEqual(parseCookies("a=1; waritomo_session=abc%2Edef"), {
    a: "1",
    waritomo_session: "abc.def",
  });
});

test("ignores malformed percent-encoding instead of throwing", () => {
  // A cookie another system left on the domain must not take down every API
  // request that happens to parse the header.
  assert.deepEqual(parseCookies("broken=%; waritomo_session=abc%2Edef"), {
    broken: "%",
    waritomo_session: "abc.def",
  });
});

test("session secret falls back only when nothing real is configured", (t) => {
  const original = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    APP_ENV: process.env.APP_ENV,
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const clearAll = () => {
    for (const key of Object.keys(original)) delete process.env[key];
  };

  clearAll();
  assert.equal(getSessionSecret(), "local-dev-session-secret");

  for (const key of ["APP_ENV", "NODE_ENV", "DATABASE_URL"]) {
    clearAll();
    process.env[key] = key === "DATABASE_URL" ? "postgres://localhost/waritomo" : "production";
    assert.throws(() => getSessionSecret(), /SESSION_SECRET is required/, `${key} must demand a secret`);

    process.env.SESSION_SECRET = "configured";
    assert.equal(getSessionSecret(), "configured");
  }
});
