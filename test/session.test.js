import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSessionToken,
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
