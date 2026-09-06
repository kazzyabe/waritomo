import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

  // The README has you migrate one throwaway container and then run the suite
  // against it repeatedly, and nothing truncates between runs. A pid is not
  // unique across those runs, so subs that must not collide get a random tail.
  const runId = randomUUID().slice(0, 8);

  let seq = 0;
  async function freshGroup() {
    seq += 1;
    const user = await users.upsertDatabaseLineUser({
      sub: `Utest_${runId}_${seq}`,
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

  test("an idle connection failing does not take the process down", async () => {
    // A pooled connection sitting idle can fail on its own — Cloud SQL
    // restarting, or scripts/gcp-db-stop.sh, which the cheap-ops runbook tells
    // you to run. Without a listener that 'error' event is an uncaught
    // exception. This asserts the listener is attached rather than stopping a
    // real database mid-suite, which the other tests are using.
    const pool = db.getPool();
    assert.ok(pool, "the pool exists once the database is configured");
    assert.ok(
      pool.listenerCount("error") > 0,
      "the pool must have an error listener, or an idle failure kills the process",
    );

    // And it has to survive the event, not just receive it.
    assert.doesNotThrow(() => pool.emit("error", new Error("idle client went away")));
  });

  test("re-logging in keeps the same user id, and the groups behind it", async () => {
    // The id is derived from the LINE user id, and groups.owner_user_id points
    // at it. If a second login ever produced a different id — a different hash,
    // encoding or length — the owner would silently lose every group they had.
    const sub = `Uidentity_${runId}`;
    const first = await users.upsertDatabaseLineUser({ sub, name: "幹事", picture: null });
    assert.match(first.id, /^usr_[0-9a-f]{24}$/, "the stored id format is load-bearing");

    const group = await store.createGroup(first, {
      name: "同一性テスト",
      members: ["幹事", "さき"],
      colors: ["#157f35", "#2171b8"],
    });

    // Log in again with a changed display name and picture, as LINE would.
    const second = await users.upsertDatabaseLineUser({
      sub,
      name: "幹事（改名）",
      picture: "https://example.com/new.png",
    });

    assert.equal(second.id, first.id, "the id must survive a re-login");
    assert.equal(second.displayName, "幹事（改名）", "the profile still updates");

    const lookedUp = await users.getDatabaseUserByLineUserId(sub);
    assert.equal(lookedUp.id, first.id);

    const stillOwned = await store.getGroup(group.id, second.id);
    assert.equal(stillOwned.id, group.id);
    assert.equal(stillOwned.canManage, true, "the group is still theirs to manage");
    assert.deepEqual((await store.listGroups(second.id)).map((g) => g.id), [group.id]);
  });

  test("a login without profile claims does not blank the stored profile", async () => {
    // LINE sends name and picture only when the profile scope was granted;
    // verifyLineIdToken guarantees nothing but sub. Writing those absences over
    // a stored profile leaves display_name null, and joinGroupByInvite falls
    // back to it — so the next invite this user accepts is a 400.
    const sub = `Uprofile_${runId}`;
    const full = await users.upsertDatabaseLineUser({
      sub,
      name: "幹事",
      picture: "https://example.com/a.png",
    });

    const bare = await users.upsertDatabaseLineUser({ sub });

    assert.equal(bare.id, full.id);
    assert.equal(bare.displayName, "幹事", "the stored name survives a token without it");
    assert.equal(bare.pictureUrl, "https://example.com/a.png");

    // A token that does carry a new name still updates it.
    const renamed = await users.upsertDatabaseLineUser({ sub, name: "幹事（改名）" });
    assert.equal(renamed.displayName, "幹事（改名）");
    assert.equal(renamed.pictureUrl, "https://example.com/a.png", "the picture is untouched");
  });

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
      sub: `Utest_shape_${runId}`,
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

  test("amounts are bounded on the value that actually gets stored", async () => {
    // Both columns are `check (amount > 0)` and it is the rounded value that
    // lands there, so bounds checked on the pre-rounded value miss: "0.4" is
    // > 0, stores as "0", and comes back from pg as 23514 — a 500 for a bad
    // request. And stripping every non-digit made "-3000" a ¥3,000 expense.
    const { user, group, members } = await freshGroup();
    const [a, b] = members;

    const addWith = (amount) =>
      store.addExpense(group.id, user.id, {
        title: "テスト",
        amount,
        payerMemberId: a.id,
        debtorMemberIds: [a.id, b.id],
      });

    for (const amount of ["0.4", "0", "-3000", "1e5", "abc100", "999999999999999"]) {
      await assert.rejects(
        addWith(amount),
        (error) => error instanceof store.StoreError && error.statusCode === 400,
        `amount=${amount} must be a 400, never a pg constraint violation`,
      );
    }

    // Ordinary formatting is still accepted, and rounds the way it reads.
    const saved = await addWith("3,000");
    assert.equal(saved.expenses.find((expense) => expense.title === "テスト").amount, 3000);
  });

  test("a color that is not a color is refused and the group is not written", async () => {
    const user = await users.upsertDatabaseLineUser({
      sub: `Utest_color_${runId}`,
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
  // A second person, so "somebody else's group" is a real user rather than an
  // id nothing ever issued. Access is refused the same way either way, but
  // only this version proves the refusal is about membership.
  async function otherUser(label) {
    return users.upsertDatabaseLineUser({ sub: `Uother_${runId}_${label}`, name: "別の人", picture: null });
  }

  test("a group goes through its whole life", async () => {
    const { user, group } = await freshGroup();

    const listed = await store.listGroups(user.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].groupName, "テスト旅行");
    assert.equal(listed[0].canManage, true);

    const renamed = await store.updateGroup(group.id, user.id, { name: "沖縄旅行" });
    assert.equal(renamed.groupName, "沖縄旅行");

    const completed = await store.updateGroup(group.id, user.id, { completed: true });
    assert.ok(completed.completedAt, "完了にすると completedAt が立つ");
    const reopened = await store.updateGroup(group.id, user.id, { completed: false });
    assert.equal(reopened.completedAt, null);

    assert.deepEqual(await store.deleteGroup(group.id, user.id), { deleted: true });
    assert.equal((await store.listGroups(user.id)).length, 0);

    // Gone means gone: the owner's own read now looks like anyone else's.
    await assert.rejects(
      store.getGroup(group.id, user.id),
      (error) => error instanceof store.StoreError && error.statusCode === 404,
    );
  });

  test("somebody else's group is not there at all", async () => {
    // 404 rather than 403 throughout: answering "forbidden" would confirm the
    // id exists to anyone who guessed it.
    const { group } = await freshGroup();
    const stranger = await otherUser("stranger");

    const notFound = (error) => error instanceof store.StoreError && error.statusCode === 404;

    await assert.rejects(store.getGroup(group.id, stranger.id), notFound);
    await assert.rejects(store.updateGroup(group.id, stranger.id, { name: "乗っ取り" }), notFound);
    await assert.rejects(store.deleteGroup(group.id, stranger.id), notFound);
    await assert.rejects(store.addMember(group.id, stranger.id, { name: "侵入者" }), notFound);
    await assert.rejects(
      store.addExpense(group.id, stranger.id, {
        title: "他人の支払い",
        amount: "1000",
        payerMemberId: group.members[0].id,
        debtorMemberIds: [group.members[0].id],
      }),
      notFound,
    );
    assert.equal((await store.listGroups(stranger.id)).length, 0, "他人のグループは一覧にも出ない");
  });

  test("a member can do member things but not owner things", async () => {
    // ensureGroupAccess and ensureGroupOwner are different gates, and only a
    // joined non-owner can tell them apart.
    const { user, group } = await freshGroup();
    const guest = await otherUser("guest");

    const joined = await store.joinGroupByInvite(group.id, guest, {
      token: group.inviteToken,
      memberId: group.members[1].id,
    });
    assert.equal(joined.canManage, false, "参加しただけの人は管理者ではない");

    // Access: adding an expense is fine.
    const withExpense = await store.addExpense(group.id, guest.id, {
      title: "参加者が足した支払い",
      amount: "1200",
      payerMemberId: group.members[1].id,
      debtorMemberIds: [group.members[0].id, group.members[1].id],
    });
    assert.equal(withExpense.expenses.length, 1);

    // Ownership: renaming and deleting are not.
    const notFound = (error) => error instanceof store.StoreError && error.statusCode === 404;
    await assert.rejects(store.updateGroup(group.id, guest.id, { name: "勝手に改名" }), notFound);
    await assert.rejects(store.deleteGroup(group.id, guest.id), notFound);

    // The owner still sees it as their own.
    assert.equal((await store.getGroup(group.id, user.id)).canManage, true);
  });

  test("an invite is only good with its own token", async () => {
    const { group } = await freshGroup();
    const guest = await otherUser("badtoken");
    const inviteNotFound = (error) => error instanceof store.StoreError && error.statusCode === 404;

    // The preview is the unauthenticated half, so a wrong token must not leak
    // the group's name or who is in it.
    await assert.rejects(store.getInvitePreview(group.id, "not-the-token"), inviteNotFound);
    await assert.rejects(store.getInvitePreview(group.id, ""), (error) => error.statusCode === 400);

    const preview = await store.getInvitePreview(group.id, group.inviteToken);
    assert.equal(preview.groupName, "テスト旅行");
    // createGroup links its creator to the first member, so that seat is the
    // one already taken and the rest are open.
    assert.deepEqual(
      preview.members.map((member) => member.available),
      [false, true, true],
      "作成者の枠だけ埋まっている",
    );

    await assert.rejects(
      store.joinGroupByInvite(group.id, guest, { token: "not-the-token", name: "ゲスト" }),
      inviteNotFound,
    );

    // A token from a different group does not open this one either.
    const { group: otherGroup } = await freshGroup();
    await assert.rejects(
      store.joinGroupByInvite(group.id, guest, { token: otherGroup.inviteToken, name: "ゲスト" }),
      inviteNotFound,
    );
  });

  test("joining twice does not make two of you", async () => {
    const { group } = await freshGroup();
    const guest = await otherUser("twice");

    const first = await store.joinGroupByInvite(group.id, guest, {
      token: group.inviteToken,
      memberId: group.members[2].id,
    });
    assert.equal(first.members.length, 3);

    // Reopening the link — the invite screen is a normal URL people revisit.
    const second = await store.joinGroupByInvite(group.id, guest, { token: group.inviteToken, name: "ぜんぜん別の名前" });
    assert.equal(second.members.length, 3, "2回目の参加でメンバーは増えない");
    assert.equal(
      second.members.filter((member) => member.linkedToCurrentUser).length,
      1,
      "自分に紐づくメンバーはひとつだけ",
    );
  });

  test("a name already taken by somebody who joined is refused", async () => {
    const { group } = await freshGroup();
    const first = await otherUser("name_first");
    const second = await otherUser("name_second");

    // Free name -> takes the empty seat rather than adding a row.
    const afterFirst = await store.joinGroupByInvite(group.id, first, { token: group.inviteToken, name: "さき" });
    assert.equal(afterFirst.members.length, 3, "空いていた同名の枠に入る");

    // Same name, now occupied.
    await assert.rejects(
      store.joinGroupByInvite(group.id, second, { token: group.inviteToken, name: "さき" }),
      (error) => error instanceof store.StoreError && error.statusCode === 409,
    );

    // Case is not a way around it.
    const { group: caseGroup } = await freshGroup();
    const upper = await otherUser("case_upper");
    const lower = await otherUser("case_lower");
    await store.joinGroupByInvite(caseGroup.id, upper, { token: caseGroup.inviteToken, name: "Taro" });
    await assert.rejects(
      store.joinGroupByInvite(caseGroup.id, lower, { token: caseGroup.inviteToken, name: "taro" }),
      (error) => error instanceof store.StoreError && error.statusCode === 409,
    );

    // A name nobody has is still fine, and does add a row.
    const third = await otherUser("name_third");
    const added = await store.joinGroupByInvite(group.id, third, { token: group.inviteToken, name: "あたらしい人" });
    assert.equal(added.members.length, 4);
  });

  test("claiming a member moves you, it does not clone you", async () => {
    const { user, group } = await freshGroup();
    const [a, b, c] = group.members;

    const claimedB = await store.claimMember(group.id, b.id, user.id);
    assert.deepEqual(
      claimedB.members.filter((member) => member.linkedToCurrentUser).map((member) => member.id),
      [b.id],
    );

    // Claiming a second one has to release the first, or one person is two
    // people in the same settlement.
    const claimedC = await store.claimMember(group.id, c.id, user.id);
    assert.deepEqual(
      claimedC.members.filter((member) => member.linkedToCurrentUser).map((member) => member.id),
      [c.id],
    );
    assert.equal(claimedC.members.find((member) => member.id === b.id).available, true);

    // Somebody else's claimed seat is a conflict, not a takeover.
    const guest = await otherUser("claim");
    await store.joinGroupByInvite(group.id, guest, { token: group.inviteToken, memberId: a.id });
    await assert.rejects(
      store.claimMember(group.id, a.id, user.id),
      (error) => error instanceof store.StoreError && error.statusCode === 409,
    );

    await assert.rejects(
      store.claimMember(group.id, "mem_does_not_exist", user.id),
      (error) => error instanceof store.StoreError && error.statusCode === 404,
    );
  });

  test("you can unlink yourself, and the owner can unlink anyone", async () => {
    const { user, group } = await freshGroup();
    const guest = await otherUser("unlink");
    const [, b] = group.members;

    await store.joinGroupByInvite(group.id, guest, { token: group.inviteToken, memberId: b.id });

    // The guest lets go of their own seat. They are no longer in the group, so
    // there is no group left to hand back.
    assert.deepEqual(await store.unlinkMember(group.id, b.id, guest.id), { unlinked: true, groupId: group.id });
    assert.equal((await store.getGroup(group.id, user.id)).members.find((member) => member.id === b.id).available, true);

    // The owner may unlink somebody else; a plain member may not.
    const otherGuest = await otherUser("unlink_other");
    const bystander = await otherUser("unlink_bystander");
    await store.joinGroupByInvite(group.id, otherGuest, { token: group.inviteToken, memberId: b.id });
    await store.joinGroupByInvite(group.id, bystander, { token: group.inviteToken, name: "傍観者" });

    await assert.rejects(
      store.unlinkMember(group.id, b.id, bystander.id),
      (error) => error instanceof store.StoreError && error.statusCode === 403,
    );

    const afterOwner = await store.unlinkMember(group.id, b.id, user.id);
    assert.equal(afterOwner.members.find((member) => member.id === b.id).available, true);

    // And a stranger cannot reach the group at all.
    const stranger = await otherUser("unlink_stranger");
    await assert.rejects(
      store.unlinkMember(group.id, b.id, stranger.id),
      (error) => error instanceof store.StoreError && error.statusCode === 404,
    );
  });
});
