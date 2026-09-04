import assert from "node:assert/strict";
import { test } from "node:test";
import { StoreError, cleanColor } from "../src/group-store.js";

test("accepts every valid hex color form", () => {
  for (const color of ["#fff", "#FFF", "#fff8", "#157f35", "#157F35", "#157f35cc"]) {
    assert.equal(cleanColor(color), color);
  }
});

test("trims surrounding whitespace like the other cleaners do", () => {
  assert.equal(cleanColor("  #157f35\n"), "#157f35");
});

test("treats an absent color as no color", () => {
  // " " has to land with "" rather than with the rejections: it is a client
  // sending nothing, not a client sending something wrong.
  for (const value of [null, undefined, "", " ", "\n"]) {
    assert.equal(cleanColor(value), null);
  }
});

test("rejects anything that is not a hex color", () => {
  const rejected = [
    'red" onmouseover="alert(1)',
    "#fff;background:url(javascript:alert(1))",
    "url(javascript:alert(1))",
    "red",
    "rgb(255,0,0)",
    "#12345",
    "#1234567",
    "#gggggg",
    "157f35",
    "#157f35\nx",
    "#157f35 #000",
    123,
    {},
  ];

  for (const value of rejected) {
    assert.throws(
      () => cleanColor(value),
      (error) => error instanceof StoreError && error.statusCode === 400,
      `${JSON.stringify(value)} must be rejected`,
    );
  }
});
