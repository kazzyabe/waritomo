import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

// The server module reads these at request time, and a stray DATABASE_URL in
// the developer's shell would otherwise point these tests at a real database.
delete process.env.DATABASE_URL;
delete process.env.APP_ENV;
delete process.env.NODE_ENV;

const { handleRequest, respondToError } = await import("../src/server.js");
const { StoreError } = await import("../src/group-store.js");

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

test("bad preview input is the caller's fault, not a 500", async () => {
  // This endpoint is unauthenticated, so answering bad input with 500 would let
  // anyone fill the log with stack traces and the dashboard with 5xx.
  const bodies = [
    undefined, // no body at all
    JSON.stringify({}),
    JSON.stringify({ members: [{ id: "m1" }] }), // needs at least two
    JSON.stringify(null),
    JSON.stringify([1, 2, 3]),
    JSON.stringify({
      members: [{ id: "m1" }, { id: "m2" }],
      expenses: [{ payerMemberId: "ghost", amount: "1", debtors: [{ memberId: "m1" }] }],
    }),
  ];

  for (const body of bodies) {
    const response = body === undefined
      ? await request("/api/settlement/preview", { method: "POST" })
      : await postPreview(body);

    assert.equal(response.status, 400, `${body} should be a 400`);
    assert.equal((await response.json()).error, "invalid_input");
  }
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

test("a 500 says nothing about what actually broke", (t) => {
  // Driven directly rather than through an endpoint, so the guarantee is not
  // tied to whichever route happens to be able to throw today.
  const logged = t.mock.method(console, "error", () => {});
  const written = [];
  const response = {
    headersSent: false,
    writeHead() {},
    end(body) {
      written.push(body);
    },
    on() {},
  };

  respondToError(
    { method: "POST", url: "/api/whatever" },
    response,
    new Error('relation "group_members" does not exist'),
  );

  assert.deepEqual(JSON.parse(written[0]), {
    error: "internal_error",
    message: "サーバーエラーが発生しました",
  });
  assert.doesNotMatch(written[0], /group_members/);

  // The detail is not discarded, it is moved to where only we can read it.
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0].arguments.at(-1)), /group_members/);
});

test("a response already on the wire is not written to twice", (t) => {
  t.mock.method(console, "error", () => {});
  let destroyed = false;
  const response = {
    headersSent: true,
    writeHead: () => assert.fail("must not write headers again"),
    end: () => assert.fail("must not write a body again"),
    destroy() {
      destroyed = true;
    },
    on() {},
  };

  respondToError({ method: "GET", url: "/late" }, response, new Error("too late"));

  assert.equal(destroyed, true);
});

test("a StoreError keeps its own status and message", () => {
  const written = [];
  let status;
  const response = {
    headersSent: false,
    writeHead(code) {
      status = code;
    },
    end(body) {
      written.push(body);
    },
    on() {},
  };

  respondToError({ method: "GET", url: "/x" }, response, new StoreError(404, "group_not_found", "グループが見つかりません"));

  assert.equal(status, 404);
  assert.deepEqual(JSON.parse(written[0]), {
    error: "group_not_found",
    message: "グループが見つかりません",
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
