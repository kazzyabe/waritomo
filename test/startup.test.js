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
  await runStartup({
    ...elements,
    initialize: async () => { throw error; },
    onError: (caught) => {
      assert.equal(elements.app.hidden, true);
      displayedError = caught;
    },
  });
  assert.equal(displayedError, error);
  assert.equal(elements.loadingScreen.hidden, true);
  assert.equal(elements.app.hidden, false);
  assert.equal(elements.app.inert, false);
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

test("declining or failing friendship never fails startup", async () => {
  await assert.doesNotReject(requestStartupFriendship(lineClient({
    requestFriendship: async () => { throw new Error("FORBIDDEN"); },
  })));
});

test("a pending friend confirmation does not delay data or keep the loader open", async () => {
  const elements = startupElements();
  const confirmation = deferred();
  let friendship;
  let dataLoaded = false;
  await runStartup({
    ...elements,
    initialize: async () => {
      friendship = requestStartupFriendship(lineClient({ requestFriendship: () => confirmation.promise }));
      dataLoaded = true;
    },
    onError: assert.fail,
  });
  assert.equal(dataLoaded, true);
  assert.equal(elements.loadingScreen.hidden, true);
  assert.equal(elements.app.hidden, false);
  confirmation.resolve();
  await friendship;
});
