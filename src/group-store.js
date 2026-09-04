import { randomBytes, randomUUID } from "node:crypto";
import { query, withTransaction } from "./db.js";

export class StoreError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function createId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function createInviteToken() {
  return randomBytes(18).toString("base64url");
}

function cleanName(value, label = "名前") {
  const name = String(value ?? "").trim();
  if (!name) throw new StoreError(400, "invalid_input", `${label}を入力してください`);
  if (name.length > 40) throw new StoreError(400, "invalid_input", `${label}が長すぎます`);
  return name;
}

function cleanAmount(value) {
  const amount = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new StoreError(400, "invalid_input", "金額を入力してください");
  }
  return String(Math.round(amount));
}

// Colors arrive from the client and are stored verbatim, so they have to be a
// color and nothing else. Anything looser eventually reaches a style attribute
// or an inline style block, and an unvalidated string there is an XSS sink.
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function cleanColor(value) {
  if (value === null || value === undefined || value === "") return null;

  const color = String(value).trim();
  if (!HEX_COLOR_PATTERN.test(color)) {
    throw new StoreError(400, "invalid_input", "メンバーの色の指定が正しくありません");
  }
  return color;
}

function cleanInviteToken(value) {
  const token = String(value ?? "").trim();
  if (!token) throw new StoreError(400, "invalid_invite", "招待リンクが無効です");
  return token;
}

function cleanMemberNames(values) {
  const names = [...new Set((values ?? []).map((value) => cleanName(value, "メンバー名")))];
  if (names.length < 2) {
    throw new StoreError(400, "invalid_input", "メンバーを2人以上入力してください");
  }
  return names;
}

async function run(client, text, params = []) {
  return client ? client.query(text, params) : query(text, params);
}

async function ensureGroupAccess(client, groupId, userId) {
  const result = await run(
    client,
    `
      select g.*
      from groups g
      where g.id = $1
        and g.archived_at is null
        and (
          g.owner_user_id = $2
          or exists (
            select 1
            from group_members gm
            where gm.group_id = g.id
              and gm.line_user_id = $2
          )
        )
    `,
    [groupId, userId],
  );

  const group = result.rows[0];
  if (!group) throw new StoreError(404, "group_not_found", "グループが見つかりません");
  return group;
}

async function ensureGroupOwner(client, groupId, userId) {
  const result = await run(
    client,
    `
      select g.*
      from groups g
      where g.id = $1
        and g.owner_user_id = $2
        and g.archived_at is null
    `,
    [groupId, userId],
  );

  const group = result.rows[0];
  if (!group) throw new StoreError(404, "group_not_found", "グループが見つかりません");
  return group;
}

async function fetchGroup(client, groupId, userId) {
  const group = await ensureGroupAccess(client, groupId, userId);
  const membersResult = await run(
    client,
    `
      select id, name, color_code, line_user_id, sort_order
      from group_members
      where group_id = $1
      order by sort_order asc, created_at asc
    `,
    [group.id],
  );

  const expensesResult = await run(
    client,
    `
      select id, title, amount::text, payer_member_id, created_at
      from expenses
      where group_id = $1
        and deleted_at is null
      order by created_at desc
    `,
    [group.id],
  );

  const expenseIds = expensesResult.rows.map((expense) => expense.id);
  const debtorRows =
    expenseIds.length === 0
      ? []
      : (
          await run(
            client,
            `
              select expense_id, member_id
              from expense_debtors
              where expense_id = any($1)
              order by member_id
            `,
            [expenseIds],
          )
        ).rows;

  const debtorsByExpense = new Map();
  debtorRows.forEach((row) => {
    const current = debtorsByExpense.get(row.expense_id) ?? [];
    current.push(row.member_id);
    debtorsByExpense.set(row.expense_id, current);
  });

  return {
    id: group.id,
    groupName: group.name,
    inviteToken: group.invite_token,
    completedAt: group.completed_at,
    updatedAt: group.updated_at,
    canManage: group.owner_user_id === userId,
    members: membersResult.rows.map((member) => ({
      id: member.id,
      name: member.name,
      color: member.color_code,
      available: !member.line_user_id,
      linkedToCurrentUser: member.line_user_id === userId,
    })),
    expenses: expensesResult.rows.map((expense) => ({
      id: expense.id,
      title: expense.title,
      amount: Number(expense.amount),
      payerMemberId: expense.payer_member_id,
      debtorMemberIds: debtorsByExpense.get(expense.id) ?? [],
      createdAt: expense.created_at,
    })),
  };
}

async function fetchSettlementConfirmations(client, groupId) {
  const result = await run(
    client,
    `
      select from_member_id, to_member_id, amount::text, currency_code, confirmed_at
      from settlement_confirmations
      where group_id = $1
      order by created_at desc
    `,
    [groupId],
  );

  return result.rows.map((row) => ({
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    amount: Number(row.amount),
    currencyCode: row.currency_code,
    confirmedAt: row.confirmed_at,
  }));
}

export async function listGroups(userId) {
  const result = await query(
    `
      select
        g.id,
        g.name,
        g.owner_user_id,
        g.completed_at,
        g.created_at,
        g.updated_at,
        (select count(*)::int from group_members gm_count where gm_count.group_id = g.id) as member_count,
        (
          select count(*)::int
          from expenses e_count
          where e_count.group_id = g.id
            and e_count.deleted_at is null
        ) as expense_count,
        (
          select coalesce(sum(e_total.amount), 0)::text
          from expenses e_total
          where e_total.group_id = g.id
            and e_total.deleted_at is null
        ) as total_amount
      from groups g
      left join group_members gm on gm.group_id = g.id
      where g.archived_at is null
        and (g.owner_user_id = $1 or gm.line_user_id = $1)
      group by g.id, g.name, g.owner_user_id, g.completed_at, g.created_at, g.updated_at
      order by g.updated_at desc, g.created_at desc
    `,
    [userId],
  );

  return result.rows.map((group) => ({
    id: group.id,
    groupName: group.name,
    memberCount: group.member_count,
    expenseCount: group.expense_count,
    totalAmount: Number(group.total_amount),
    completedAt: group.completed_at,
    updatedAt: group.updated_at,
    canManage: group.owner_user_id === userId,
  }));
}

export async function getGroup(groupId, userId) {
  return fetchGroup(null, groupId, userId);
}

export async function getInvitePreview(groupId, inviteToken) {
  const result = await query(
    `
      select id, name
      from groups
      where id = $1
        and invite_token = $2
        and archived_at is null
    `,
    [groupId, cleanInviteToken(inviteToken)],
  );

  const group = result.rows[0];
  if (!group) throw new StoreError(404, "invite_not_found", "招待リンクが見つかりません");

  const membersResult = await query(
    `
      select id, name, color_code, line_user_id
      from group_members
      where group_id = $1
      order by sort_order asc, created_at asc
    `,
    [group.id],
  );

  return {
    id: group.id,
    groupName: group.name,
    members: membersResult.rows.map((member) => ({
      id: member.id,
      name: member.name,
      color: member.color_code,
      available: !member.line_user_id,
    })),
  };
}

export async function joinGroupByInvite(groupId, user, input) {
  const inviteToken = cleanInviteToken(input.token);
  const memberId = String(input.memberId ?? "").trim();
  const name = String(input.name ?? "").trim();

  return withTransaction(async (client) => {
    const groupResult = await client.query(
      `
        select id
        from groups
        where id = $1
          and invite_token = $2
          and archived_at is null
      `,
      [groupId, inviteToken],
    );

    const group = groupResult.rows[0];
    if (!group) throw new StoreError(404, "invite_not_found", "招待リンクが見つかりません");

    const existingUserMember = await client.query(
      "select id from group_members where group_id = $1 and line_user_id = $2",
      [groupId, user.id],
    );
    if (existingUserMember.rows[0]) return fetchGroup(client, groupId, user.id);

    if (memberId) {
      const memberResult = await client.query(
        "select id, line_user_id from group_members where id = $1 and group_id = $2",
        [memberId, groupId],
      );
      const member = memberResult.rows[0];
      if (!member) throw new StoreError(404, "member_not_found", "メンバーが見つかりません");
      if (member.line_user_id && member.line_user_id !== user.id) {
        throw new StoreError(409, "member_already_claimed", "このメンバーは参加済みです");
      }

      await client.query("update group_members set line_user_id = $1, updated_at = now() where id = $2", [
        user.id,
        member.id,
      ]);
      await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
      return fetchGroup(client, groupId, user.id);
    }

    const cleanMemberName = cleanName(name || user.displayName, "表示名");
    const duplicateResult = await client.query(
      "select id, line_user_id from group_members where group_id = $1 and lower(name) = lower($2)",
      [groupId, cleanMemberName],
    );
    const duplicate = duplicateResult.rows[0];
    if (duplicate?.line_user_id) {
      throw new StoreError(409, "member_name_taken", "同じ名前のメンバーが参加済みです");
    }
    if (duplicate) {
      await client.query("update group_members set line_user_id = $1, updated_at = now() where id = $2", [
        user.id,
        duplicate.id,
      ]);
      await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
      return fetchGroup(client, groupId, user.id);
    }

    await client.query(
      `
        insert into group_members (id, group_id, line_user_id, name, color_code, sort_order)
        values (
          $1,
          $2,
          $3,
          $4,
          $5,
          (select coalesce(max(sort_order), -1) + 1 from group_members where group_id = $2)
        )
      `,
      [createId("mem"), groupId, user.id, cleanMemberName, cleanColor(input.color)],
    );
    await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
    return fetchGroup(client, groupId, user.id);
  });
}

export async function claimMember(groupId, memberId, userId) {
  return withTransaction(async (client) => {
    await ensureGroupAccess(client, groupId, userId);

    const memberResult = await client.query(
      "select id, line_user_id from group_members where id = $1 and group_id = $2",
      [memberId, groupId],
    );
    const member = memberResult.rows[0];
    if (!member) throw new StoreError(404, "member_not_found", "メンバーが見つかりません");
    if (member.line_user_id && member.line_user_id !== userId) {
      throw new StoreError(409, "member_already_claimed", "このメンバーは参加済みです");
    }

    await client.query(
      "update group_members set line_user_id = null, updated_at = now() where group_id = $1 and line_user_id = $2 and id <> $3",
      [groupId, userId, memberId],
    );
    await client.query("update group_members set line_user_id = $1, updated_at = now() where id = $2", [
      userId,
      memberId,
    ]);
    await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
    return fetchGroup(client, groupId, userId);
  });
}

export async function unlinkMember(groupId, memberId, userId) {
  return withTransaction(async (client) => {
    const group = await ensureGroupAccess(client, groupId, userId);
    const memberResult = await client.query(
      "select id, line_user_id from group_members where id = $1 and group_id = $2",
      [memberId, groupId],
    );
    const member = memberResult.rows[0];
    if (!member) throw new StoreError(404, "member_not_found", "メンバーが見つかりません");
    if (member.line_user_id !== userId && group.owner_user_id !== userId) {
      throw new StoreError(403, "member_link_forbidden", "自分の紐づけだけ解除できます");
    }

    await client.query("update group_members set line_user_id = null, updated_at = now() where id = $1", [memberId]);
    await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);

    if (group.owner_user_id !== userId && member.line_user_id === userId) {
      return { unlinked: true, groupId };
    }
    return fetchGroup(client, groupId, userId);
  });
}

export async function createGroup(user, input) {
  const groupName = cleanName(input.name, "グループ名");
  const memberNames = cleanMemberNames(input.members);

  return withTransaction(async (client) => {
    const groupId = createId("grp");
    await client.query(
      `
        insert into groups (id, owner_user_id, name, base_currency_code, rounding_unit, invite_token)
        values ($1, $2, $3, 'JPY', 1, $4)
      `,
      [groupId, user.id, groupName, createInviteToken()],
    );

    // The first name belongs to whoever is creating the group, so it is linked
    // to their LINE account immediately. Everyone else stays unlinked until
    // they claim themselves through the invite link. The creation form marks
    // the first entry as "you" so this ordering is not a hidden assumption.
    for (const [index, name] of memberNames.entries()) {
      await client.query(
        `
          insert into group_members (id, group_id, line_user_id, name, color_code, sort_order)
          values ($1, $2, $3, $4, $5, $6)
        `,
        [
          createId("mem"),
          groupId,
          index === 0 ? user.id : null,
          name,
          cleanColor(input.colors?.[index]),
          index,
        ],
      );
    }

    return fetchGroup(client, groupId, user.id);
  });
}

export async function updateGroup(groupId, userId, input) {
  const patch = input && typeof input === "object" ? input : {};

  return withTransaction(async (client) => {
    await ensureGroupOwner(client, groupId, userId);

    const updates = [];
    const values = [];

    if (Object.hasOwn(patch, "name")) {
      values.push(cleanName(patch.name, "グループ名"));
      updates.push(`name = $${values.length}`);
    }

    if (Object.hasOwn(patch, "completed")) {
      if (patch.completed === true) {
        updates.push("completed_at = now()");
      } else if (patch.completed === false) {
        updates.push("completed_at = null");
      } else {
        throw new StoreError(400, "invalid_input", "完了状態が無効です");
      }
    }

    if (updates.length === 0) return fetchGroup(client, groupId, userId);

    values.push(groupId);
    await client.query(
      `
        update groups
        set ${updates.join(", ")},
            updated_at = now()
        where id = $${values.length}
      `,
      values,
    );

    return fetchGroup(client, groupId, userId);
  });
}

export async function addMember(groupId, userId, input) {
  const name = cleanName(input.name, "メンバー名");

  return withTransaction(async (client) => {
    await ensureGroupAccess(client, groupId, userId);

    const duplicateResult = await client.query(
      "select 1 from group_members where group_id = $1 and name = $2",
      [groupId, name],
    );
    if (duplicateResult.rows[0]) {
      throw new StoreError(409, "duplicate_member_name", `「${name}」は既にメンバーにいます`);
    }

    await client.query(
      `
        insert into group_members (id, group_id, name, color_code, sort_order)
        values (
          $1,
          $2,
          $3,
          $4,
          (select coalesce(max(sort_order), -1) + 1 from group_members where group_id = $2)
        )
      `,
      [createId("mem"), groupId, name, cleanColor(input.color)],
    );
    await client.query("delete from settlement_confirmations where group_id = $1", [groupId]);
    await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
    return fetchGroup(client, groupId, userId);
  });
}

export async function deleteMember(groupId, memberId, userId) {
  return withTransaction(async (client) => {
    await ensureGroupAccess(client, groupId, userId);

    const countResult = await client.query("select count(*)::int as count from group_members where group_id = $1", [
      groupId,
    ]);
    if (countResult.rows[0].count <= 2) {
      throw new StoreError(400, "too_few_members", "メンバーは2人以上必要です");
    }

    const memberResult = await client.query("select id from group_members where id = $1 and group_id = $2", [
      memberId,
      groupId,
    ]);
    if (!memberResult.rows[0]) throw new StoreError(404, "member_not_found", "メンバーが見つかりません");

    await client.query(
      "delete from expense_debtors where expense_id in (select id from expenses where payer_member_id = $1)",
      [memberId],
    );
    await client.query("delete from expenses where payer_member_id = $1", [memberId]);
    await client.query("delete from expense_debtors where member_id = $1", [memberId]);
    await client.query("delete from group_members where id = $1", [memberId]);

    await client.query("delete from settlement_confirmations where group_id = $1", [groupId]);
    await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
    return fetchGroup(client, groupId, userId);
  });
}

async function validateExpenseInput(client, groupId, input) {
  const title = cleanName(input.title, "内容");
  const amount = cleanAmount(input.amount);
  const payerMemberId = String(input.payerMemberId ?? "");
  const debtorMemberIds = [...new Set((input.debtorMemberIds ?? []).map(String))];

  if (debtorMemberIds.length === 0) {
    throw new StoreError(400, "invalid_input", "割り勘する人を選んでください");
  }

  const memberResult = await client.query("select id from group_members where group_id = $1", [groupId]);
  const memberIds = new Set(memberResult.rows.map((member) => member.id));
  if (!memberIds.has(payerMemberId)) throw new StoreError(400, "invalid_input", "支払った人を選んでください");
  debtorMemberIds.forEach((currentMemberId) => {
    if (!memberIds.has(currentMemberId)) throw new StoreError(400, "invalid_input", "割り勘する人を選んでください");
  });

  return { title, amount, payerMemberId, debtorMemberIds };
}

export async function addExpense(groupId, userId, input) {
  return withTransaction(async (client) => {
    await ensureGroupAccess(client, groupId, userId);
    const { title, amount, payerMemberId, debtorMemberIds } = await validateExpenseInput(client, groupId, input);

    const expenseId = createId("exp");
    await client.query(
      `
        insert into expenses (
          id, group_id, payer_member_id, created_by_user_id, title,
          currency_code, amount, rate_to_base, split_mode
        )
        values ($1, $2, $3, $4, $5, 'JPY', $6, 1, 'equal')
      `,
      [expenseId, groupId, payerMemberId, userId, title, amount],
    );

    for (const memberId of debtorMemberIds) {
      await client.query("insert into expense_debtors (expense_id, member_id, amount) values ($1, $2, 0)", [
        expenseId,
        memberId,
      ]);
    }

    await client.query("delete from settlement_confirmations where group_id = $1", [groupId]);
    await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
    return fetchGroup(client, groupId, userId);
  });
}

export async function updateExpense(groupId, expenseId, userId, input) {
  return withTransaction(async (client) => {
    await ensureGroupAccess(client, groupId, userId);
    const { title, amount, payerMemberId, debtorMemberIds } = await validateExpenseInput(client, groupId, input);

    const result = await client.query(
      `
        update expenses
        set title = $1,
            amount = $2,
            payer_member_id = $3,
            updated_at = now()
        where id = $4
          and group_id = $5
          and deleted_at is null
        returning id
      `,
      [title, amount, payerMemberId, expenseId, groupId],
    );
    if (!result.rows[0]) throw new StoreError(404, "expense_not_found", "支払いが見つかりません");

    await client.query("delete from expense_debtors where expense_id = $1", [expenseId]);
    for (const memberId of debtorMemberIds) {
      await client.query("insert into expense_debtors (expense_id, member_id, amount) values ($1, $2, 0)", [
        expenseId,
        memberId,
      ]);
    }
    await client.query("delete from settlement_confirmations where group_id = $1", [groupId]);
    await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
    return fetchGroup(client, groupId, userId);
  });
}

export async function deleteExpense(groupId, expenseId, userId) {
  return withTransaction(async (client) => {
    await ensureGroupAccess(client, groupId, userId);
    const result = await client.query(
      `
        update expenses
        set deleted_at = now(), updated_at = now()
        where id = $1
          and group_id = $2
          and deleted_at is null
        returning id
      `,
      [expenseId, groupId],
    );

    if (!result.rows[0]) throw new StoreError(404, "expense_not_found", "支払いが見つかりません");
    await client.query("delete from settlement_confirmations where group_id = $1", [groupId]);
    await client.query("update groups set completed_at = null, updated_at = now() where id = $1", [groupId]);
    return fetchGroup(client, groupId, userId);
  });
}

export async function deleteGroup(groupId, userId) {
  return withTransaction(async (client) => {
    await ensureGroupOwner(client, groupId, userId);

    await client.query("delete from settlement_confirmations where group_id = $1", [groupId]);
    await client.query(
      "delete from expense_debtors where expense_id in (select id from expenses where group_id = $1)",
      [groupId],
    );
    await client.query("delete from expenses where group_id = $1", [groupId]);
    await client.query("delete from group_currencies where group_id = $1", [groupId]);
    await client.query("delete from audit_events where group_id = $1", [groupId]);
    await client.query("delete from group_members where group_id = $1", [groupId]);
    await client.query("delete from groups where id = $1", [groupId]);

    return { deleted: true };
  });
}

export async function listSettlementConfirmations(groupId, userId) {
  await ensureGroupAccess(null, groupId, userId);
  return fetchSettlementConfirmations(null, groupId);
}

export async function setSettlementConfirmation(groupId, userId, input) {
  const fromMemberId = String(input.fromMemberId ?? "");
  const toMemberId = String(input.toMemberId ?? "");
  const amount = cleanAmount(input.amount);
  const checked = input.checked !== false;

  return withTransaction(async (client) => {
    await ensureGroupAccess(client, groupId, userId);

    const memberResult = await client.query("select id from group_members where group_id = $1", [groupId]);
    const memberIds = new Set(memberResult.rows.map((member) => member.id));
    if (!memberIds.has(fromMemberId) || !memberIds.has(toMemberId) || fromMemberId === toMemberId) {
      throw new StoreError(400, "invalid_input", "清算するメンバーを選んでください");
    }

    await client.query(
      `
        delete from settlement_confirmations
        where group_id = $1
          and from_member_id = $2
          and to_member_id = $3
          and amount = $4
          and currency_code = 'JPY'
      `,
      [groupId, fromMemberId, toMemberId, amount],
    );

    if (checked) {
      await client.query(
        `
          insert into settlement_confirmations (
            id, group_id, from_member_id, to_member_id, amount, currency_code,
            marked_paid_by_user_id, confirmed_by_user_id, marked_paid_at, confirmed_at
          )
          values ($1, $2, $3, $4, $5, 'JPY', $6, $6, now(), now())
        `,
        [createId("stl"), groupId, fromMemberId, toMemberId, amount, userId],
      );
    }

    return fetchSettlementConfirmations(client, groupId);
  });
}
