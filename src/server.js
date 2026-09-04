import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { pipeline } from "node:stream";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDatabaseAvailable, isDatabaseEnabled, migrateDatabase } from "./db.js";
import { getDatabaseUserByLineUserId, upsertDatabaseLineUser } from "./db-users.js";
import { safeDecodeURIComponent } from "./decode.js";
import {
  StoreError,
  addExpense,
  addMember,
  claimMember,
  createGroup,
  deleteExpense,
  deleteGroup,
  deleteMember,
  getInvitePreview,
  getGroup,
  joinGroupByInvite,
  listSettlementConfirmations,
  listGroups,
  setSettlementConfirmation,
  unlinkMember,
  updateExpense,
  updateGroup,
} from "./group-store.js";
import { LineAuthError, verifyLineIdToken } from "./line-auth.js";
import {
  createExpiredSessionCookie,
  createSessionCookie,
  createSessionToken,
  getSessionFromRequest,
  getSessionSecret,
} from "./session.js";
import { SettlementInputError, calculateSettlement } from "./settlement.js";
import { getUserByLineUserId, upsertLineUser } from "./users.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(rootDir, "public");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

// No legitimate request here carries a megabyte. This caps what one request can
// put on the heap. The rest of a rejected body still has to come down the wire
// and be thrown away: destroying the socket instead reaches the client as a
// connection reset rather than as the 413 explaining what went wrong.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendJsonWithHeaders(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`).replace(/\/$/, "");
}

function getMiniAppBaseUrl() {
  const liffId = process.env.LINE_LIFF_ID ?? "";
  const configured = process.env.LINE_MINIAPP_BASE_URL;
  if (configured) return configured.replace("{liffId}", liffId).replace(/\/$/, "");
  return liffId ? `https://miniapp.line.me/${liffId}` : "";
}

function buildPermanentLink(path) {
  const miniAppBaseUrl = getMiniAppBaseUrl();
  if (!miniAppBaseUrl) return null;

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${miniAppBaseUrl}${normalizedPath}`;
}

function shouldUseSecureCookie() {
  return getPublicBaseUrl().startsWith("https://") || process.env.APP_ENV === "production";
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    lineUserId: user.lineUserId,
    displayName: user.displayName,
    pictureUrl: user.pictureUrl,
  };
}

async function getCurrentUser(request) {
  const session = getSessionFromRequest(request);
  if (!session?.lineUserId) return null;
  if (isDatabaseEnabled()) return getDatabaseUserByLineUserId(session.lineUserId);
  return getUserByLineUserId(session.lineUserId);
}

async function requireDatabaseUser(request) {
  if (!isDatabaseEnabled()) {
    throw new StoreError(503, "database_not_configured", "DATABASE_URL is not configured");
  }

  const user = await getCurrentUser(request);
  if (!user) {
    throw new StoreError(401, "authentication_required", "LINEログインが必要です");
  }
  return user;
}

export function settlementInputFromGroup(group) {
  // An expense with no debtors is unsettleable, and calculateSettlement says so
  // by refusing the whole group. Removing a member used to leave exactly that
  // behind (fixed in deleteMember), so any group already carrying one would be
  // stuck on a permanent 500. Nobody owes anything for it, so it contributes
  // nothing to drop.
  const settleable = group.expenses.filter((expense) => expense.debtorMemberIds.length > 0);

  return {
    baseCurrencyCode: "JPY",
    roundingUnit: "1",
    members: group.members.map((member) => ({ id: member.id })),
    expenses: settleable.map((expense) => ({
      payerMemberId: expense.payerMemberId,
      title: expense.title,
      splitMode: "equal",
      amount: String(expense.amount),
      debtors: expense.debtorMemberIds.map((memberId) => ({ memberId })),
    })),
  };
}

// calculateSettlement rejects bad input ("At least two members are required").
// Left unmapped those become 500s, which lets an unauthenticated caller mint
// stack traces in our logs and spikes in our 5xx alerting at will. Only its
// deliberate rejections are translated: anything else escaping that function is
// our bug, and burying it behind a 400 would hide it from the same alerting.
function previewSettlement(body) {
  try {
    return calculateSettlement(body);
  } catch (error) {
    if (!(error instanceof SettlementInputError)) throw error;
    // The message describes the caller's own payload, so it is safe to echo.
    throw new StoreError(400, "invalid_input", error.message);
  }
}

// The other caller of calculateSettlement. A rejection here is our stored data
// failing to express a settlement, not a bad request — the caller cannot fix it
// and retrying will not help — so it stays a 5xx. It gets its own code and log
// line because, unlike a one-off bad request, it would repeat on every visit to
// the group's main screen until someone looked.
function settlementForGroup(group) {
  try {
    return calculateSettlement(settlementInputFromGroup(group));
  } catch (error) {
    if (!(error instanceof SettlementInputError)) throw error;

    console.error("settlement input rejected for group", group.id, error.message);
    throw new StoreError(500, "settlement_unavailable", "清算を計算できませんでした");
  }
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map(safeDecodeURIComponent);
}

function payloadTooLarge() {
  return new StoreError(413, "payload_too_large", "リクエストが大きすぎます");
}

// Read the body by hand rather than with `for await`: breaking out of an async
// iterator destroys the request, which tears the socket down before the 413 can
// be written. Reading it manually keeps the connection able to carry the answer.
function requestAborted() {
  return new StoreError(400, "request_aborted", "リクエストが中断されました");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    // Every route reaches here after an await — a database round trip, a call
    // to LINE — and the client can disappear during it. Node destroys the
    // request and deliberately swallows the error while nothing is listening,
    // so subscribing afterwards finds a stream that will never emit again.
    if (request.destroyed || request.readableEnded) {
      reject(requestAborted());
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
      finish(value);
    };

    function onData(chunk) {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        settle(reject, payloadTooLarge());
        // Attaching a `data` listener already set the request's internal
        // `_consuming` flag, and Node only auto-drains a body it never started
        // consuming. Without this the rest of the upload is never read, so the
        // response finishes but the connection sits wedged until it times out —
        // and on a keep-alive connection every later request behind it hangs.
        // `settle` has removed our listeners, so resuming discards the rest.
        request.resume();
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      settle(resolve, Buffer.concat(chunks));
    }

    function onError(error) {
      settle(reject, error);
    }

    // The backstop. `close` fires whether the request ended cleanly or was torn
    // down, and it is the only one of these guaranteed to arrive — without it a
    // client that resets mid-request leaves this promise pending forever, and
    // the whole handler frame pinned behind it.
    function onClose() {
      settle(reject, requestAborted());
    }

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
  });
}

export async function readJson(request) {
  // Well-behaved clients announce the size up front, so the common oversized
  // case never touches the socket buffer at all.
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw payloadTooLarge();
  }

  const body = await readBody(request);
  if (body.length === 0) return {};

  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new StoreError(400, "invalid_json", "リクエストの形式が正しくありません");
  }

  // `null`, `[]` and `7` are all valid JSON, and every route here reads fields
  // off what it gets back. This is the top level only — the shape of each field
  // is the store's to check, and it does.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StoreError(400, "invalid_json", "リクエストの形式が正しくありません");
  }

  return parsed;
}

function sendFile(response, filePath, headers) {
  // writeHead commits the 200. Anything that goes wrong after this point can
  // only be a destroyed socket, so the file has to be known-good first.
  response.writeHead(200, headers);
  // `pipe` neither forwards read errors (an unhandled one would take the
  // process down) nor destroys the source when the client goes away mid
  // download, which leaks the file descriptor. `pipeline` does both.
  pipeline(createReadStream(filePath), response, (error) => {
    if (error) console.error("static file stream failed", filePath, error);
  });
}

function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const unsafePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(unsafePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = getStaticFilePath(safePath);
  // Read the extension off what the client asked for, not off safePath: "/" has
  // already been rewritten to "/index.html" by here, which would send a missing
  // shell down the 404 branch instead of the one that reports it.
  const requestNamesAFile = Boolean(extname(url.pathname));

  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) throw new Error("Not a file");

    sendFile(response, filePath, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    });
  } catch {
    // A path that names a file is asking for that file. Answering a missing
    // script or image with 200 and the app shell hides the breakage from the
    // browser, from monitoring, and from every cache in between.
    if (requestNamesAFile) {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Not Found");
      return;
    }

    const shellPath = join(publicDir, "index.html");
    try {
      statSync(shellPath);
    } catch (error) {
      // Without this the missing shell is a 200 with an empty body: a blank
      // page for the user and a healthy service to whatever is watching it.
      console.error("app shell is missing", shellPath, error);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Internal Server Error");
      return;
    }

    sendFile(response, shellPath, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
  }
}

function getStaticFilePath(safePath) {
  const filePath = join(publicDir, safePath);
  if (extname(filePath)) return filePath;

  try {
    const htmlPath = `${filePath}.html`;
    const stats = statSync(htmlPath);
    if (stats.isFile()) return htmlPath;
  } catch {
    return filePath;
  }

  return filePath;
}

async function handleApi(request, response) {
  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      appMode: "line-mini-app",
      publicBaseUrl: getPublicBaseUrl(),
      line: {
        liffId: process.env.LINE_LIFF_ID ?? "",
        miniAppBaseUrl: getMiniAppBaseUrl(),
      },
      storage: {
        mode: "database",
      },
      analytics: {
        measurementId: process.env.GA_MEASUREMENT_ID ?? "",
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/storage/status") {
    sendJson(response, 200, {
      mode: "database",
      available: await checkDatabaseAvailable(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/line") {
    const body = await readJson(request);
    const linePayload = await verifyLineIdToken(body.idToken);
    const user = (await upsertDatabaseLineUser(linePayload)) ?? upsertLineUser(linePayload);
    const sessionToken = createSessionToken({
      userId: user.id,
      lineUserId: user.lineUserId,
    });

    sendJsonWithHeaders(
      response,
      200,
      {
        authenticated: true,
        user: publicUser(user),
      },
      {
        "set-cookie": createSessionCookie(sessionToken, {
          secure: shouldUseSecureCookie(),
        }),
      },
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    sendJsonWithHeaders(
      response,
      200,
      { ok: true },
      {
        "set-cookie": createExpiredSessionCookie(),
      },
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    const user = await getCurrentUser(request);
    sendJson(response, 200, {
      authenticated: Boolean(user),
      user: publicUser(user),
    });
    return;
  }

  if (url.pathname === "/api/groups" && request.method === "GET") {
    const user = await requireDatabaseUser(request);
    sendJson(response, 200, {
      storage: "database",
      groups: await listGroups(user.id),
    });
    return;
  }

  if (url.pathname === "/api/groups" && request.method === "POST") {
    const user = await requireDatabaseUser(request);
    sendJson(response, 201, await createGroup(user, await readJson(request)));
    return;
  }

  const parts = splitPath(url.pathname);
  if (parts[0] === "api" && parts[1] === "invites" && parts[2]) {
    const groupId = parts[2];

    if (parts.length === 3 && request.method === "GET") {
      sendJson(response, 200, await getInvitePreview(groupId, url.searchParams.get("token")));
      return;
    }

    if (parts.length === 4 && parts[3] === "join" && request.method === "POST") {
      const user = await requireDatabaseUser(request);
      sendJson(response, 200, await joinGroupByInvite(groupId, user, await readJson(request)));
      return;
    }
  }

  if (parts[0] === "api" && parts[1] === "groups" && parts[2]) {
    const user = await requireDatabaseUser(request);
    const groupId = parts[2];

    if (parts.length === 3 && request.method === "GET") {
      sendJson(response, 200, await getGroup(groupId, user.id));
      return;
    }

    if (parts.length === 3 && request.method === "PATCH") {
      sendJson(response, 200, await updateGroup(groupId, user.id, await readJson(request)));
      return;
    }

    if (parts.length === 3 && request.method === "DELETE") {
      sendJson(response, 200, await deleteGroup(groupId, user.id));
      return;
    }

    if (parts.length === 4 && parts[3] === "settlement" && request.method === "GET") {
      const group = await getGroup(groupId, user.id);
      sendJson(response, 200, {
        ...settlementForGroup(group),
        confirmations: await listSettlementConfirmations(groupId, user.id),
      });
      return;
    }

    if (parts.length === 5 && parts[3] === "settlement" && parts[4] === "confirmations" && request.method === "POST") {
      sendJson(response, 200, {
        confirmations: await setSettlementConfirmation(groupId, user.id, await readJson(request)),
      });
      return;
    }

    if (parts.length === 4 && parts[3] === "members" && request.method === "POST") {
      sendJson(response, 201, await addMember(groupId, user.id, await readJson(request)));
      return;
    }

    if (parts.length === 5 && parts[3] === "members" && request.method === "DELETE") {
      sendJson(response, 200, await deleteMember(groupId, parts[4], user.id));
      return;
    }

    if (parts.length === 6 && parts[3] === "members" && parts[5] === "claim" && request.method === "POST") {
      sendJson(response, 200, await claimMember(groupId, parts[4], user.id));
      return;
    }

    if (parts.length === 6 && parts[3] === "members" && parts[5] === "claim" && request.method === "DELETE") {
      sendJson(response, 200, await unlinkMember(groupId, parts[4], user.id));
      return;
    }

    if (parts.length === 4 && parts[3] === "expenses" && request.method === "POST") {
      sendJson(response, 201, await addExpense(groupId, user.id, await readJson(request)));
      return;
    }

    if (parts.length === 5 && parts[3] === "expenses" && request.method === "PATCH") {
      sendJson(response, 200, await updateExpense(groupId, parts[4], user.id, await readJson(request)));
      return;
    }

    if (parts.length === 5 && parts[3] === "expenses" && request.method === "DELETE") {
      sendJson(response, 200, await deleteExpense(groupId, parts[4], user.id));
      return;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/permanent-link") {
    const path = url.searchParams.get("path") ?? "/";
    const permanentLink = buildPermanentLink(path);

    if (!permanentLink) {
      sendJson(response, 400, {
        error: "line_mini_app_not_configured",
        message: "Set LINE_LIFF_ID or LINE_MINIAPP_BASE_URL.",
      });
      return;
    }

    sendJson(response, 200, {
      endpointUrl: `${getPublicBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`,
      permanentLink,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settlement/preview") {
    sendJson(response, 200, previewSettlement(await readJson(request)));
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

export function respondToError(request, response, error) {
  // Once a response has started there is nothing left to say; writing again
  // would throw ERR_HTTP_HEADERS_SENT out of the error handler itself.
  if (response.headersSent) {
    console.error("request failed after response started", request.method, request.url, error);
    response.destroy();
    return;
  }

  // Only the 4xx side of this is about the caller's token. A 5xx LineAuthError
  // is our own misconfiguration ("LINE_CHANNEL_ID is not configured") or a raw
  // upstream response in `details`, and it falls through to the generic reply.
  if (error instanceof LineAuthError && error.statusCode < 500) {
    sendJson(response, error.statusCode, {
      error: "line_auth_error",
      message: error.message,
      details: error.details,
    });
    return;
  }

  if (error instanceof StoreError) {
    sendJson(response, error.statusCode, {
      error: error.code,
      message: error.message,
    });
    return;
  }

  // The detail belongs in the server log, not in the response: error.message
  // here is whatever pg, node, or a parser produced, and that leaks schema and
  // infrastructure to anyone who can provoke a failure.
  console.error("unhandled request error", request.method, request.url, error);
  sendJson(response, 500, {
    error: "internal_error",
    message: "サーバーエラーが発生しました",
  });
}

export async function handleRequest(request, response) {
  try {
    if (request.url?.startsWith("/api/")) {
      await handleApi(request, response);
      return;
    }

    serveStatic(request, response);
  } catch (error) {
    try {
      respondToError(request, response, error);
    } catch (failure) {
      // Writing to a socket the client already dropped must not surface as an
      // unhandled rejection, which would take the whole process with it.
      console.error("failed to send error response", request.method, request.url, failure);
      response.destroy();
    }
  }
}

// Importing this module must not bind a port — the tests drive `handleRequest`
// through a server of their own — so starting up is an explicit call that only
// src/main.js makes. Detecting "am I the entry point?" from argv was the
// alternative, and every way that guess can be wrong exits 0 with no server
// and nothing in the log.
export async function startServer() {
  // Fail the deploy rather than the first request that needs a session: a
  // missing SESSION_SECRET is a configuration error, and a revision that
  // cannot sign sessions should never take traffic.
  getSessionSecret();

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";

  if (process.env.DB_AUTO_MIGRATE === "true" && isDatabaseEnabled()) {
    try {
      await migrateDatabase();
      console.log("database schema applied");
    } catch (error) {
      console.error("database schema migration failed", error);
    }
  }

  const server = createServer(handleRequest);
  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`waritomo listening on ${host}:${port}`);
  return server;
}
