import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateSettlement } from "../src/settlement.js";

test("splits one equal expense across all members", () => {
  const result = calculateSettlement({
    baseCurrencyCode: "JPY",
    roundingUnit: "1",
    members: [{ id: "a" }, { id: "b" }, { id: "c" }],
    expenses: [
      {
        payerMemberId: "a",
        splitMode: "equal",
        amount: "3000",
        debtors: [{ memberId: "a" }, { memberId: "b" }, { memberId: "c" }],
      },
    ],
  });

  assert.deepEqual(result.items, [
    { fromMemberId: "b", toMemberId: "a", amount: "1000" },
    { fromMemberId: "c", toMemberId: "a", amount: "1000" },
  ]);
});

test("cancels balances across multiple expenses", () => {
  const result = calculateSettlement({
    members: [{ id: "a" }, { id: "b" }],
    expenses: [
      {
        payerMemberId: "a",
        splitMode: "equal",
        amount: "1000",
        debtors: [{ memberId: "a" }, { memberId: "b" }],
      },
      {
        payerMemberId: "b",
        splitMode: "equal",
        amount: "400",
        debtors: [{ memberId: "a" }, { memberId: "b" }],
      },
    ],
  });

  assert.deepEqual(result.items, [{ fromMemberId: "b", toMemberId: "a", amount: "300" }]);
});

test("supports custom debtor amounts", () => {
  const result = calculateSettlement({
    members: [{ id: "a" }, { id: "b" }, { id: "c" }],
    expenses: [
      {
        payerMemberId: "a",
        splitMode: "custom",
        amount: "1000",
        debtors: [
          { memberId: "b", amount: "700" },
          { memberId: "c", amount: "300" },
        ],
      },
    ],
  });

  assert.deepEqual(result.items, [
    { fromMemberId: "b", toMemberId: "a", amount: "700" },
    { fromMemberId: "c", toMemberId: "a", amount: "300" },
  ]);
});

test("rejects custom splits that do not match the expense amount", () => {
  assert.throws(() =>
    calculateSettlement({
      members: [{ id: "a" }, { id: "b" }],
      expenses: [
        {
          payerMemberId: "a",
          splitMode: "custom",
          amount: "1000",
          debtors: [{ memberId: "b", amount: "999" }],
        },
      ],
    }),
  );
});

