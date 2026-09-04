import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

// These exercise real SQL, because the two worst bugs in this branch were both
// invisible without it: a foreign key with no ON DELETE CASCADE, and a delete
// that left a row nothing else could make sense of.
//
// Opt in by pointing WARITOMO_TEST_DATABASE_URL at a throwaway database:
//
//   docker run -d --name waritomo-test-pg -e POSTGRES_PASSWORD=pw \
//     -e POSTGRES_DB=waritomo -p 55433:5432 postgres:16-alpine
//   DATABASE_URL=postgres://postgres:pw@127.0.0.1:55433/waritomo npm run db:migrate
//   WARITOMO_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55433/waritomo npm test
//
// Without it the suite still runs; this file skips.
const databaseUrl = process.env.WARITOMO_TEST_DATABASE_URL;

describe("group store against a real database", { skip: databaseUrl ? false : "WARITOMO_TEST_DATABASE_URL is not set" }, () => {
  let store;
  let users;
  let db;
  let serverModule;
  let settlement;

  before(async () => {
    process.env.DATABASE_URL = databaseUrl;
    store = await import("../src/group-store.js");
    users = await import("../src/db-users.js");
    db = await import("../src/db.js");
    serverModule = await import("../src/server.js");
    settlement = await import("../src/settlement.js");
  });

  after(async () => {
    // The pool keeps the event loop alive, so the runner would hang without this.
    await db.getPool()?.end();
  });

  let seq = 0;
  async function freshGroup() {
    seq += 1;
    const user = await users.upsertDatabaseLineUser({
      sub: `Utest_${process.pid}_${seq}`,
      name: "幹事",
      picture: null,
    });
    const group = await store.createGroup(user, {
      name: "テスト旅行",
      members: ["幹事", "さき", "たろう"],
      colors: ["#157f35", "#2171b8", "#147b74"],
    });
    return { user, group, members: group.members };
  }

  test("a member who appears in a confirmed transfer can still be removed", async () => {
    // settlement_confirmations references group_members with no ON DELETE
    // CASCADE, so deleting the member first raised 23503, rolled the whole
    // transaction back, and the member stayed forever.
    const { user, group, members } = await freshGroup();
    const [a, b, c] = members;

    await store.addExpense(group.id, user.id, {
      title: "居酒屋",
      amount: "3000",
      payerMemberId: a.id,
      debtorMemberIds: [a.id, b.id, c.id],
    });

    await store.setSettlementConfirmation(group.id, user.id, {
      fromMemberId: b.id,
      toMemberId: a.id,
      amount: "1000",
      checked: true,
    });

    const remaining = await store.deleteMember(group.id, b.id, user.id);

    assert.equal(remaining.members.length, 2);
    assert.ok(!remaining.members.some((member) => member.id === b.id));
  });

  test("removing a member takes the expenses only they owed with them", async () => {
    // An expense with no debtors left is unsettleable, and calculateSettlement
    // refuses the whole group over it — so the settlement 500'd from then on.
    const { user, group, members } = await freshGroup();
    const [a, b, c] = members;

    await store.addExpense(group.id, user.id, {
      title: "居酒屋",
      amount: "3000",
      payerMemberId: a.id,
      debtorMemberIds: [a.id, b.id],
    });
    await store.addExpense(group.id, user.id, {
      title: "たろうのタクシー代",
      amount: "5000",
      payerMemberId: a.id,
      debtorMemberIds: [c.id],
    });

    await store.deleteMember(group.id, c.id, user.id);
    const remaining = await store.getGroup(group.id, user.id);

    assert.deepEqual(
      remaining.expenses.map((expense) => expense.title),
      ["居酒屋"],
    );
    assert.equal(
      remaining.expenses.filter((expense) => expense.debtorMemberIds.length === 0).length,
      0,
      "no expense is left with nobody owing anything",
    );

    const settled = settlement.calculateSettlement(serverModule.settlementInputFromGroup(remaining));
    assert.deepEqual(settled.items, [{ fromMemberId: b.id, toMemberId: a.id, amount: "1500" }]);
  });

  test("an amount the column cannot hold is refused before pg sees it", async () => {
    // expenses.amount is numeric(18,4). Past that pg raises "numeric field
    // overflow", which the generic handler turns into a masked 500 for what is
    // plainly a bad request.
    const { user, group, members } = await freshGroup();
    const [a, b] = members;

    await assert.rejects(
      store.addExpense(group.id, user.id, {
        title: "大きすぎる支払い",
        amount: "999999999999999",
        payerMemberId: a.id,
        debtorMemberIds: [a.id, b.id],
      }),
      (error) => error instanceof store.StoreError && error.statusCode === 400,
    );

    // The widest value the column does hold still goes in.
    const saved = await store.addExpense(group.id, user.id, {
      title: "ぎりぎり",
      amount: "99999999999999",
      payerMemberId: a.id,
      debtorMemberIds: [a.id, b.id],
    });
    assert.ok(saved.expenses.some((expense) => expense.title === "ぎりぎり"));
  });

  test("a field that should be a list but is not is a 400, not a crash", async () => {
    // `?? []` only guards null and undefined; a string or object sails past it
    // and dies on .map. readJson rejects a non-object body but cannot see the
    // shape of the fields inside it, so the store has to check its own.
    const user = await users.upsertDatabaseLineUser({
      sub: `Utest_shape_${process.pid}`,
      name: "幹事",
      picture: null,
    });

    for (const members of ["abc", 5, {}, true]) {
      await assert.rejects(
        store.createGroup(user, { name: "x", members }),
        (error) => error instanceof store.StoreError && error.statusCode === 400,
        `members=${JSON.stringify(members)} must be a 400`,
      );
    }

    await assert.rejects(
      store.createGroup(user, { name: "x", members: ["幹事", "さき"], colors: "abc" }),
      (error) => error instanceof store.StoreError && error.statusCode === 400,
    );

    const { user: owner, group, members } = await freshGroup();
    for (const debtorMemberIds of ["abc", {}, 5, true]) {
      await assert.rejects(
        store.addExpense(group.id, owner.id, {
          title: "テスト",
          amount: "1000",
          payerMemberId: members[0].id,
          debtorMemberIds,
        }),
        (error) => error instanceof store.StoreError && error.statusCode === 400,
        `debtorMemberIds=${JSON.stringify(debtorMemberIds)} must be a 400`,
      );
    }
  });

  test("a color that is not a color is refused and the group is not written", async () => {
    const user = await users.upsertDatabaseLineUser({
      sub: `Utest_color_${process.pid}`,
      name: "幹事",
      picture: null,
    });

    await assert.rejects(
      store.createGroup(user, {
        name: "壊れた色",
        members: ["幹事", "さき"],
        colors: ["#157f35", 'red" onmouseover="alert(1)'],
      }),
      (error) => error instanceof store.StoreError && error.statusCode === 400,
    );

    // withTransaction has to have rolled the half-built group back.
    const groups = await store.listGroups(user.id);
    assert.equal(groups.length, 0, "the rejected group left nothing behind");
  });
});
