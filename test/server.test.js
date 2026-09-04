import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { after, before, test } from "node:test";

// The server module reads these at request time, and a stray DATABASE_URL in
// the developer's shell would otherwise point these tests at a real database.
delete process.env.DATABASE_URL;
delete process.env.APP_ENV;
delete process.env.NODE_ENV;

const { handleRequest, readJson, respondToError, settlementInputFromGroup } = await import("../src/server.js");
const { StoreError } = await import("../src/group-store.js");
const { LineAuthError } = await import("../src/line-auth.js");
const { calculateSettlement } = await import("../src/settlement.js");

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

// fetch normalises "//" and absolute-form targets before they reach the wire,
// so these have to go out by hand.
function rawRequest(target) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.address().port, "127.0.0.1");
    let received = "";

    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error(`timed out on ${target}`));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      received += chunk;
    });
    socket.on("close", () => resolve(received));
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });
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

test("a body that is valid JSON but not an object is rejected for every route", async () => {
  // Every handler reads fields off the parsed body, so `null`, `[]` and `7`
  // would each become a TypeError and a logged 500 on whichever route was
  // missed. These two are the ones that parse a body before any gate, so they
  // are reachable by a stranger; the rest stop at auth or database config.
  const routes = ["/api/settlement/preview", "/api/auth/line"];

  for (const path of routes) {
    for (const body of ["null", "[1,2,3]", "7", '"hello"']) {
      const response = await request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      assert.equal(response.status, 400, `${path} with ${body} should be a 400`);
      assert.equal((await response.json()).error, "invalid_json");
    }
  }
});

test("an absurdly long number cannot be turned into a much longer answer", async () => {
  // Unbounded digits let one request inside the body cap block the event loop
  // on BigInt arithmetic and answer with several times what it sent.
  const huge = "9".repeat(500000);
  const response = await postPreview(
    JSON.stringify({
      members: [{ id: "a" }, { id: "b" }],
      expenses: [
        { payerMemberId: "a", amount: huge, splitMode: "equal", debtors: [{ memberId: "b" }] },
      ],
    }),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_input");
});

test("structurally odd preview payloads are still the caller's fault", async () => {
  // These reached calculateSettlement as objects and threw TypeErrors deep
  // inside it ("debtors.forEach is not a function"). That read as our bug: a
  // 500 with a stack, from an unauthenticated endpoint, echoing internals.
  const bodies = [
    { members: [{ id: "a" }, { id: "b" }], expenses: {} },
    { members: "ab", expenses: [] },
    {
      members: [{ id: "a" }, { id: "b" }],
      expenses: [{ payerMemberId: "a", amount: "1", debtors: {} }],
    },
  ];

  for (const body of bodies) {
    const response = await postPreview(JSON.stringify(body));

    assert.equal(response.status, 400, `${JSON.stringify(body)} should be a 400`);
    assert.equal((await response.json()).error, "invalid_input");
  }
});

test("a genuine fault inside the settlement code is still a 500", (t) => {
  // The 400 mapping must not swallow our own bugs, or the alerting this hunk
  // exists to protect goes quiet exactly when it matters.
  t.mock.method(console, "error", () => {});
  const response = collectResponse();

  respondToError({ method: "POST", url: "/api/settlement/preview" }, response, new TypeError("x is not a function"));

  assert.equal(response.status, 500);
  assert.equal(JSON.parse(response.written[0]).error, "internal_error");
});

test("an oversized declared body is rejected before it is buffered", async () => {
  const response = await postPreview("x".repeat(1024 * 1024 + 1));

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "payload_too_large",
    message: "リクエストが大きすぎます",
  });
});

test("a client that vanishes mid-request does not pin the handler forever", async () => {
  // Every route reads its body after an await, and Node destroys an aborted
  // request while nothing is listening — swallowing the error. A reader that
  // subscribes afterwards waits on a stream that will never emit again, and
  // the whole handler frame stays pinned behind the pending promise.
  const settled = [];
  const probe = createServer(async (request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 120)); // stands in for the DB round trip
    await readJson(request).then(
      () => settled.push("resolved"),
      () => settled.push("rejected"),
    );
    try {
      response.end("ok");
    } catch {
      // The socket is gone; that is the case under test.
    }
  });

  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const socket = connect(port, "127.0.0.1");
      await new Promise((resolve) => socket.on("connect", resolve));
      socket.write(
        "POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      socket.resetAndDestroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(settled.length, 3, `every read must settle, got ${JSON.stringify(settled)}`);
  } finally {
    await new Promise((resolve) => probe.close(resolve));
  }
});

test("a rejected upload does not wedge the connection behind it", async () => {
  // Attaching a data listener marks the request consumed, so Node stops
  // auto-draining it. If the rest of a rejected body is never read, the socket
  // sits half-full: the 413 arrives, and then every later request on that
  // keep-alive connection hangs until the server times it out.
  const body = "x".repeat(2 * 1024 * 1024);
  const port = server.address().port;

  const replies = await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";

    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`connection wedged; only got: ${received.slice(0, 120)}`));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      received += chunk;
      // Wait for the 413 and then the health check behind it.
      if (received.includes('{"ok":true}')) {
        socket.destroy();
        resolve(received);
      }
    });

    socket.write(
      "POST /api/settlement/preview HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: application/json\r\n" +
        "Transfer-Encoding: chunked\r\n\r\n",
    );
    for (let sent = 0; sent < body.length; sent += 65536) {
      const chunk = body.slice(sent, sent + 65536);
      socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    }
    socket.write("0\r\n\r\n");
    socket.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  });

  assert.match(replies, /HTTP\/1\.1 413/);
  assert.match(replies, /payload_too_large/);
  // The second response is the point: the connection survived the rejection.
  assert.match(replies, /HTTP\/1\.1 200/);
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

function collectResponse() {
  const written = [];
  return {
    written,
    status: undefined,
    headersSent: false,
    writeHead(code) {
      this.status = code;
    },
    end(body) {
      written.push(body);
    },
    on() {},
  };
}

test("a StoreError keeps its own status and message", () => {
  const response = collectResponse();

  respondToError({ method: "GET", url: "/x" }, response, new StoreError(404, "group_not_found", "グループが見つかりません"));

  assert.equal(response.status, 404);
  assert.deepEqual(JSON.parse(response.written[0]), {
    error: "group_not_found",
    message: "グループが見つかりません",
  });
});

test("a 4xx LineAuthError reaches the caller, a 5xx one does not", (t) => {
  // The 4xx is about the caller's token and they need to read it. The 5xx is
  // our own misconfiguration — "LINE_CHANNEL_ID is not configured" names an
  // environment variable, and `details` carries the raw upstream response.
  const rejected = collectResponse();
  respondToError({ method: "POST", url: "/api/auth/line" }, rejected, new LineAuthError("IDトークンが無効です", 401));

  assert.equal(rejected.status, 401);
  assert.equal(JSON.parse(rejected.written[0]).message, "IDトークンが無効です");

  t.mock.method(console, "error", () => {});
  const misconfigured = collectResponse();
  respondToError(
    { method: "POST", url: "/api/auth/line" },
    misconfigured,
    new LineAuthError("LINE_CHANNEL_ID is not configured", 500),
  );

  assert.equal(misconfigured.status, 500);
  assert.deepEqual(JSON.parse(misconfigured.written[0]), {
    error: "internal_error",
    message: "サーバーエラーが発生しました",
  });
  assert.doesNotMatch(misconfigured.written[0], /LINE_CHANNEL_ID/);
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

test("a group carrying an unsettleable expense still settles", () => {
  // Removing a member used to strip an expense's last debtor and leave the
  // expense behind. calculateSettlement refuses that, and with the message now
  // redacted the group's settlement was a permanent, unexplained 500.
  const group = {
    members: [{ id: "m1" }, { id: "m2" }],
    expenses: [
      { payerMemberId: "m1", title: "居酒屋", amount: 3000, debtorMemberIds: ["m1", "m2"] },
      { payerMemberId: "m1", title: "取り残された支払い", amount: 5000, debtorMemberIds: [] },
    ],
  };

  const input = settlementInputFromGroup(group);

  assert.equal(input.expenses.length, 1, "the unsettleable expense is dropped");
  assert.equal(input.expenses[0].title, "居酒屋");

  const settled = calculateSettlement(input);
  assert.deepEqual(settled.items, [{ fromMemberId: "m2", toMemberId: "m1", amount: "1500" }]);
});

test("a request target that is not origin-form is a 400, not a 500", async () => {
  // `new URL("//", base)` throws, and it used to throw outside the try in
  // serveStatic — an unauthenticated stack trace generator. The authority and
  // absolute forms are rejected for a different reason: `new URL` reads a host
  // out of them, so the router matched one path and serveStatic served another
  // ("//api/health" resolved to "/health" and answered 200 with the shell).
  const targets = ["//", "///", "//?a=1", "//:", "//@", "//%", "//[", "/\\/", "//\\",
    "//api/health", "http://example.com/whatever", "*"];

  for (const target of targets) {
    const raw = await rawRequest(target);
    assert.match(raw, /^HTTP\/1\.1 400 /, `${JSON.stringify(target)} should be a 400`);
    assert.match(raw, /invalid_request_target/);
  }
});

test("ordinary targets are unaffected", async () => {
  for (const [target, expected] of [["/api/health", 200], ["/", 200], ["/robots.txt", 200], ["/nope.js", 404]]) {
    const raw = await rawRequest(target);
    assert.match(raw, new RegExp(`^HTTP/1\\.1 ${expected} `), `${target} should be ${expected}`);
  }
});

test("unknown API routes are 404", async () => {
  const response = await request("/api/nope");

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "not_found");
});
