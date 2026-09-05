import { createHash } from "node:crypto";
import { query } from "./db.js";

// Every id in line_users came out of this, and six columns across five tables
// reference those ids. Changing the hash, the encoding or the length orphans
// every group, member and expense already stored. It does not get "unified"
// with anything; anything else gets deleted instead.
function stableUserId(lineUserId) {
  return `usr_${createHash("sha256").update(lineUserId).digest("hex").slice(0, 24)}`;
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
  };
}

export async function upsertDatabaseLineUser(linePayload) {
  const lineUserId = linePayload.sub;
  const result = await query(
    `
      insert into line_users (id, line_user_id, display_name, picture_url, updated_at)
      values ($1, $2, $3, $4, now())
      on conflict (line_user_id)
      do update set
        display_name = excluded.display_name,
        picture_url = excluded.picture_url,
        updated_at = now()
      returning *
    `,
    [
      stableUserId(lineUserId),
      lineUserId,
      linePayload.name ?? null,
      linePayload.picture ?? null,
    ],
  );

  return toPublicUser(result.rows[0]);
}

export async function getDatabaseUserByLineUserId(lineUserId) {
  const result = await query("select * from line_users where line_user_id = $1", [lineUserId]);
  return toPublicUser(result.rows[0]);
}
