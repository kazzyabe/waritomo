import assert from "node:assert/strict";
import { test } from "node:test";
import { safeDecodeURIComponent } from "../src/decode.js";

test("decodes ordinary percent-encoding", () => {
  assert.equal(safeDecodeURIComponent("grp%5F1"), "grp_1");
  assert.equal(safeDecodeURIComponent("%E3%81%95%E3%81%8D"), "さき");
});

test("returns the raw text instead of throwing on malformed encoding", () => {
  assert.equal(safeDecodeURIComponent("%"), "%");
  assert.equal(safeDecodeURIComponent("%zz"), "%zz");
  assert.equal(safeDecodeURIComponent("100%off"), "100%off");
  assert.equal(safeDecodeURIComponent("%E3%81"), "%E3%81");
});
