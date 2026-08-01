import { createHash } from "node:crypto";

const usersByLineUserId = new Map();

function stableUserId(lineUserId) {
  return `usr_${createHash("sha256").update(lineUserId).digest("base64url").slice(0, 22)}`;
}

export function upsertLineUser(linePayload) {
  const existing = usersByLineUserId.get(linePayload.sub);
  const user = {
    id: existing?.id ?? stableUserId(linePayload.sub),
    lineUserId: linePayload.sub,
    displayName: linePayload.name ?? existing?.displayName ?? null,
    pictureUrl: linePayload.picture ?? existing?.pictureUrl ?? null,
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  usersByLineUserId.set(linePayload.sub, user);
  return user;
}

export function getUserByLineUserId(lineUserId) {
  return usersByLineUserId.get(lineUserId) ?? null;
}

export function clearUserStoreForTests() {
  usersByLineUserId.clear();
}

