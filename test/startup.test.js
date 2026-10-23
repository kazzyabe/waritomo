import test from "node:test";
import assert from "node:assert/strict";
import { runStartup, requestStartupFriendship } from "../public/startup.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function startupElements() {
  return {
    app: { hidden: false, inert: false, setAttribute(name, value) { this[name] = value; } },
    loadingScreen: { hidden: true },
  };
}

function lineClient(overrides = {}) {
  return {
    isInClient: () => true,
    isLoggedIn: () => true,
    isApiAvailable: (name) => name === "requestFriendship",
    getFriendship: async () => ({ friendFlag: false }),
    requestFriendship: async () => {},
    ...overrides,
  };
}

test("startup hides interactive content until initial data is ready", async () => {
  const elements = startupElements();
  const data = deferred();
  const startup = runStartup({ ...elements, initialize: () => data.promise, onError: assert.fail });
  assert.equal(elements.loadingScreen.hidden, false);
  assert.equal(elements.app.hidden, true);
  assert.equal(elements.app.inert, true);
  assert.equal(elements.app["aria-busy"], "true");
  data.resolve();
  await startup;
  assert.equal(elements.loadingScreen.hidden, true);
  assert.equal(elements.app.hidden, false);
  assert.equal(elements.app.inert, false);
  assert.equal(elements.app["aria-busy"], "false");
});

test("startup reveals the error state after a rejected initial request", async () => {
  const elements = startupElements();
  const error = new Error("offline");
  let displayedError;
  let readyCalls = 0;
  await runStartup({
    ...elements,
    initialize: async () => { throw error; },
    onError: (caught) => {
      assert.equal(elements.app.hidden, true);
      displayedError = caught;
    },
    afterReady: () => { readyCalls += 1; },
    waitForPaint: assert.fail,
  });
  assert.equal(displayedError, error);
  assert.equal(elements.loadingScreen.hidden, true);
  assert.equal(elements.app.hidden, false);
  assert.equal(elements.app.inert, false);
  assert.equal(readyCalls, 0);
});

test("an early initialization return also releases the loading screen", async () => {
  const elements = startupElements();
  await runStartup({ ...elements, initialize: async () => {}, onError: assert.fail });
  assert.equal(elements.loadingScreen.hidden, true);
  assert.equal(elements.app.hidden, false);
});

test("friendship uses LINE's default linked account and minimal confirmation", async () => {
  const calls = [];
  await requestStartupFriendship(lineClient({ requestFriendship: async (...args) => calls.push(args) }));
  assert.deepEqual(calls, [[]]);
});

test("friendship is skipped for friends, external browsers and unsupported clients", async (t) => {
  for (const overrides of [
    { getFriendship: async () => ({ friendFlag: true }) },
    { isInClient: () => false },
    { isLoggedIn: () => false },
    { isApiAvailable: () => false },
    { isApiAvailable: undefined },
  ]) {
    await t.test(JSON.stringify(Object.keys(overrides)), async () => {
      let requests = 0;
      await requestStartupFriendship(lineClient({ requestFriendship: async () => { requests += 1; }, ...overrides }));
      assert.equal(requests, 0);
    });
  }
  await assert.doesNotReject(requestStartupFriendship(undefined));
  await assert.doesNotReject(requestStartupFriendship(lineClient({ requestFriendship: undefined })));
});

test("a friendship lookup failure still allows the native confirmation", async () => {
  let requested = false;
  await requestStartupFriendship(lineClient({
    getFriendship: async () => { throw new Error("temporary failure"); },
    requestFriendship: async () => { requested = true; },
  }));
  assert.equal(requested, true);
});

test("unsupported and failed native confirmations return diagnostic results", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  assert.equal(await requestStartupFriendship(lineClient({ isApiAvailable: () => false })), "unsupported");
  assert.equal(await requestStartupFriendship(lineClient({ requestFriendship: undefined })), "unsupported");
  assert.equal(await requestStartupFriendship(lineClient({
    requestFriendship: async () => { throw { code: "FORBIDDEN" }; },
  })), "failed");
  assert.deepEqual(warning.mock.calls[0].arguments, ["LINE friendship confirmation unavailable", "FORBIDDEN"]);
  assert.equal(await requestStartupFriendship(lineClient()), "requested");
});

test("known friends are skipped even on unsupported LINE versions", async () => {
  assert.equal(await requestStartupFriendship(lineClient({
    getFriendship: async () => ({ friendFlag: true }),
    isApiAvailable: () => false,
  })), "already-friend");
});

test("friend confirmation waits for data and the revealed screen to paint", async () => {
  const elements = startupElements();
  const data = deferred();
  const paint = deferred();
  const confirmation = deferred();
  const confirmationStarted = deferred();
  let friendship;
  let paintRequested = false;
  let requests = 0;
  const startup = runStartup({
    ...elements,
    initialize: () => data.promise,
    waitForPaint: () => {
      assert.equal(elements.loadingScreen.hidden, true);
      assert.equal(elements.app.hidden, false);
      paintRequested = true;
      return paint.promise;
    },
    afterReady: () => {
      friendship = requestStartupFriendship(lineClient({ requestFriendship: () => { requests += 1; confirmationStarted.resolve(); return confirmation.promise; } }));
      return friendship;
    },
    onError: assert.fail,
  });
  assert.equal(paintRequested, false);
  assert.equal(requests, 0);
  data.resolve();
  await Promise.resolve();
  assert.equal(paintRequested, true);
  assert.equal(requests, 0);
  paint.resolve();
  await startup;
  await confirmationStarted.promise;
  assert.equal(requests, 1);
  assert.equal(elements.loadingScreen.hidden, true);
  assert.equal(elements.app.hidden, false);
  confirmation.resolve();
  await friendship;
});

test("even instant data loading schedules friendship after the screen paint", async () => {
  const events = [];
  const elements = startupElements();
  await runStartup({
    ...elements,
    initialize: async () => { events.push("data"); },
    waitForPaint: async () => {
      assert.equal(elements.app.hidden, false);
      assert.equal(elements.loadingScreen.hidden, true);
      events.push("paint");
    },
    afterReady: () => { events.push("friendship"); },
    onError: assert.fail,
  });
  assert.deepEqual(events, ["data", "paint", "friendship"]);
});
