import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyLineIdToken } from "../src/line-auth.js";

test("verifies LINE ID token using official verify endpoint shape", async () => {
  const payload = await verifyLineIdToken("id-token", {
    channelId: "12345",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.line.me/oauth2/v2.1/verify");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(options.body.get("id_token"), "id-token");
      assert.equal(options.body.get("client_id"), "12345");

      return new Response(JSON.stringify({ sub: "U123", aud: "12345", name: "Aoi" }), {
        status: 200,
      });
    },
  });

  assert.equal(payload.sub, "U123");
  assert.equal(payload.name, "Aoi");
});

test("rejects token with mismatched audience", async () => {
  await assert.rejects(
    () =>
      verifyLineIdToken("id-token", {
        channelId: "12345",
        fetchImpl: async () =>
          new Response(JSON.stringify({ sub: "U123", aud: "wrong" }), {
            status: 200,
          }),
      }),
    /audience/,
  );
});

