import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

// The server module reads these at request time, and a stray DATABASE_URL in
// the developer's shell would otherwise point these tests at a real database.
delete process.env.DATABASE_URL;
delete process.env.APP_ENV;
delete process.env.NODE_ENV;

const { handleRequest } = await import("../src/server.js");

let server;
let origin;

before(async () => {
  server = createServer(handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function request(path, options = {}) {
  return fetch(`${origin}${path}`, options);
}

const VALID_PREVIEW = {
  baseCurrencyCode: "JPY",
  roundingUnit: "1",
  members: [{ id: "m1" }, { id: "m2" }],
  expenses: [
    {
      payerMemberId: "m1",
      title: "居酒屋",
      splitMode: "equal",
      amount: "3000",
      debtors: [{ memberId: "m1" }, { memberId: "m2" }],
    },
  ],
};

function postPreview(body, headers = {}) {
  return request("/api/settlement/preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

test("serves robots.txt as text and keeps groups out of the index", async () => {
  const response = await request("/robots.txt");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");

  const body = await response.text();
  assert.match(body, /^User-agent: \*$/m);
  assert.match(body, /^Disallow: \/groups\/$/m);
});

test("a missing asset is a 404, not the app shell", async () => {
  for (const path of ["/missing.js", "/assets/missing.png", "/styles/gone.css"]) {
    const response = await request(path);
    assert.equal(response.status, 404, `${path} should 404`);
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/html/);
  }
});

test("extensionless routes still fall back to the app shell", async () => {
  for (const path of ["/", "/groups/grp_1", "/groups/grp_1/invite"]) {
    const response = await request(path);
    assert.equal(response.status, 200, `${path} should serve the shell`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  }
});

test("static pages are served from their own file", async () => {
  const response = await request("/privacy");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
});

test("malformed JSON is a 400, not a 500", async () => {
  const response = await postPreview("{not json");

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_json",
    message: "リクエストの形式が正しくありません",
  });
});

test("a well-formed body still works", async () => {
  const response = await postPreview(JSON.stringify(VALID_PREVIEW));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.items));
});

test("an empty body is treated as an empty object", async (t) => {
  // No body at all reaches calculateSettlement as {}, which rejects it for
  // having no members — the point is that it parses rather than throwing.
  t.mock.method(console, "error", () => {});

  const response = await request("/api/settlement/preview", { method: "POST" });

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "internal_error");
});

test("an oversized declared body is rejected before it is buffered", async () => {
  const response = await postPreview("x".repeat(1024 * 1024 + 1));

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "payload_too_large",
    message: "リクエストが大きすぎます",
  });
});

test("an oversized streamed body is rejected mid-stream", async () => {
  // No content-length, so the limit has to hold while the body is arriving.
  const chunk = "x".repeat(64 * 1024);
  const stream = new ReadableStream({
    start(controller) {
      for (let sent = 0; sent < 1024 * 1024 + chunk.length; sent += chunk.length) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

  const response = await request("/api/settlement/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "payload_too_large");
});

test("a 500 says nothing about what actually broke", async (t) => {
  // calculateSettlement throws a plain Error naming its own invariant; that
  // string is exactly the kind of internal detail that must not ship out.
  t.mock.method(console, "error", () => {});

  const response = await postPreview(JSON.stringify({ members: [{ id: "m1" }] }));

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "internal_error",
    message: "サーバーエラーが発生しました",
  });
});

test("a malformed cookie does not break the request", async () => {
  const response = await request("/api/me", {
    headers: { cookie: "broken=%; waritomo_session=%E3%81" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false, user: null });
});

test("a malformed path segment does not break routing", async () => {
  const response = await request("/api/groups/%E3%81/expenses", { method: "POST" });

  // Without a database this stops at the configuration check; the point is that
  // the undecodable segment never reaches the top-level handler as a URIError.
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "database_not_configured");
});

test("unknown API routes are 404", async () => {
  const response = await request("/api/nope");

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "not_found");
});
