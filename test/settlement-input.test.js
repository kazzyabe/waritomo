import assert from "node:assert/strict";
import { test } from "node:test";
import { SettlementInputError, calculateSettlement } from "../src/settlement.js";

// /api/settlement/preview is unauthenticated and hands its body straight to
// calculateSettlement, and the server turns a SettlementInputError into a 400
// and anything else into a logged 500. So "which exception type" is not a
// detail here: every payload a stranger can post has to come out of this
// function as a SettlementInputError, or they can fill our logs at will.
//
// Rather than chase these one shape at a time, build the hostile values
// combinatorially and assert the property over all of them.

const HOSTILE = [
  undefined,
  null,
  true,
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "abc",
  "1e5",
  "0x10",
  "１０００", // full-width digits
  " 12 ",
  [],
  [null],
  {},
  { id: null },
];

function everyExpense() {
  const expenses = [];
  for (const amount of HOSTILE) {
    expenses.push({ payerMemberId: "a", amount, splitMode: "equal", debtors: [{ memberId: "b" }] });
    expenses.push({ payerMemberId: "a", amount: "10", splitMode: "equal", debtors: [{ memberId: "b" }], rateToBase: amount });
    expenses.push({ payerMemberId: "a", amount: "10", splitMode: "custom", debtors: [{ memberId: "b", amount }] });
    expenses.push({ payerMemberId: amount, amount: "10", splitMode: "equal", debtors: [{ memberId: "b" }] });
    expenses.push({ payerMemberId: "a", amount: "10", splitMode: amount, debtors: [{ memberId: "b" }] });
    expenses.push({ payerMemberId: "a", amount: "10", splitMode: "equal", debtors: amount });
    expenses.push({ payerMemberId: "a", amount: "10", splitMode: "equal", debtors: [amount] });
  }
  return expenses;
}

function everyPayload() {
  const members = [{ id: "a" }, { id: "b" }];
  const payloads = [];

  for (const value of HOSTILE) {
    payloads.push(value);
    payloads.push({ members: value });
    payloads.push({ members: [value, { id: "b" }] });
    payloads.push({ members, expenses: value });
    payloads.push({ members, expenses: [value] });
    payloads.push({ members, expenses: [], roundingUnit: value });
    payloads.push({ members, expenses: [], baseCurrencyCode: value });
  }

  for (const expense of everyExpense()) {
    payloads.push({ members, expenses: [expense] });
    payloads.push({ members, expenses: [expense], roundingUnit: "1" });
  }

  return payloads;
}

test("no client-supplied payload escapes as anything but a SettlementInputError", () => {
  const payloads = everyPayload();
  let rejected = 0;
  let accepted = 0;

  for (const payload of payloads) {
    try {
      calculateSettlement(payload);
      accepted += 1;
    } catch (error) {
      if (!(error instanceof SettlementInputError)) {
        assert.fail(
          `${error.constructor.name}: ${error.message}\n  escaped from ${JSON.stringify(payload)}`,
        );
      }
      rejected += 1;
    }
  }

  // Guard the guard: if a refactor made everything pass or everything fail,
  // the property above would still hold while proving nothing. At the time of
  // writing this is 378 payloads, 333 rejected and 45 benign enough to compute.
  assert.ok(payloads.length > 300, `expected a broad matrix, built ${payloads.length}`);
  assert.ok(rejected > 250, `expected most hostile payloads to be rejected, got ${rejected}`);
  assert.ok(accepted > 20, `expected the valid-ish payloads to still compute, got ${accepted}`);
});

test("the amounts and entries that used to escape are named plainly", () => {
  const members = [{ id: "a" }, { id: "b" }];
  const cases = [
    [{ members: [null, { id: "b" }] }, /member must be an object/],
    [{ members: [{ id: 1 }, { id: "b" }] }, /member id must be a non-empty string/],
    [{ members, expenses: [null] }, /expense must be an object/],
    [
      { members, expenses: [{ payerMemberId: "a", amount: "abc", splitMode: "equal", debtors: [{ memberId: "b" }] }] },
      /expense amount must be a decimal amount/,
    ],
    [
      { members, expenses: [{ payerMemberId: "a", amount: "1", splitMode: "equal", debtors: [null] }] },
      /debtor must be an object/,
    ],
    [{ members, expenses: [], roundingUnit: "zz" }, /roundingUnit must be a decimal amount/],
  ];

  for (const [payload, expected] of cases) {
    assert.throws(() => calculateSettlement(payload), expected);
  }
});

test("valid input is untouched by the new guards", () => {
  const result = calculateSettlement({
    baseCurrencyCode: "JPY",
    roundingUnit: "1",
    members: [{ id: "a" }, { id: "b" }],
    expenses: [
      {
        payerMemberId: "a",
        amount: "3000",
        splitMode: "equal",
        debtors: [{ memberId: "a" }, { memberId: "b" }],
      },
    ],
  });

  assert.deepEqual(result.items, [{ fromMemberId: "b", toMemberId: "a", amount: "1500" }]);
});
