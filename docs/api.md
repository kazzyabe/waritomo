# API Design

All endpoints are under `/api`.

## Auth

### `POST /api/auth/line`

Verifies a LINE ID token and creates an app session cookie. The backend verifies
the token with LINE's ID token verification endpoint. Frontend-sent profile data
is not trusted.

Request:

```json
{
  "idToken": "string"
}
```

Response:

```json
{
  "authenticated": true,
  "user": {
    "id": "usr_...",
    "lineUserId": "U...",
    "displayName": "Aoi",
    "pictureUrl": "https://..."
  }
}
```

Set-Cookie:

```text
waritomo_session=...; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600
```

### `POST /api/auth/logout`

Clears the app session.

## Current User

### `GET /api/me`

Returns the current app user. If there is no valid session, it returns
`authenticated: false`.

Response:

```json
{
  "authenticated": true,
  "user": {
    "id": "usr_...",
    "lineUserId": "U...",
    "displayName": "Aoi",
    "pictureUrl": null
  }
}
```

### `GET /api/me/groups`

Returns groups the user owns or has claimed a member in.

## Groups

### `POST /api/groups`

Creates a group.

Request:

```json
{
  "name": "北海道旅行",
  "baseCurrencyCode": "JPY",
  "roundingUnit": 1,
  "members": ["あおい", "れん", "みな"],
  "currencies": ["JPY", "USD"]
}
```

### `GET /api/groups/:groupId`

Returns group, members, currencies, and current user's role.

### `PATCH /api/groups/:groupId`

Updates group settings. Owner only.

### `GET /api/invites/:inviteToken`

Returns limited preview for an invite link.

### `POST /api/groups/:groupId/join`

Claims a member profile or creates a new member if group settings allow it.

Request:

```json
{
  "memberId": "mem_..."
}
```

## Members

### `POST /api/groups/:groupId/members`

Adds an unclaimed member. Owner or member, depending on group policy.

### `PATCH /api/groups/:groupId/members/:memberId`

Renames a member or changes color.

### `DELETE /api/groups/:groupId/members/:memberId`

Removes a member if no expense depends on them.

## Expenses

### `GET /api/groups/:groupId/expenses`

Lists expenses.

### `POST /api/groups/:groupId/expenses`

Creates an expense.

Request:

```json
{
  "payerMemberId": "mem_...",
  "title": "タクシー",
  "currencyCode": "JPY",
  "amount": "4800",
  "splitMode": "equal",
  "debtors": [
    { "memberId": "mem_1" },
    { "memberId": "mem_2" }
  ]
}
```

For custom split:

```json
{
  "payerMemberId": "mem_...",
  "title": "ホテル",
  "currencyCode": "JPY",
  "amount": "30000",
  "splitMode": "custom",
  "debtors": [
    { "memberId": "mem_1", "amount": "10000" },
    { "memberId": "mem_2", "amount": "20000" }
  ]
}
```

### `GET /api/groups/:groupId/expenses/:expenseId`

Reads an expense.

### `PATCH /api/groups/:groupId/expenses/:expenseId`

Updates an expense and writes an audit event.

### `DELETE /api/groups/:groupId/expenses/:expenseId`

Soft-deletes an expense and writes an audit event.

## Settlement

### `GET /api/groups/:groupId/settlement`

Returns computed settlement suggestions.

Response:

```json
{
  "baseCurrencyCode": "JPY",
  "items": [
    {
      "fromMemberId": "mem_1",
      "toMemberId": "mem_2",
      "amount": "2400",
      "status": "open"
    }
  ]
}
```

### `POST /api/groups/:groupId/settlement/confirmations`

Marks a settlement item as paid or confirmed.

## Sharing

### `POST /api/groups/:groupId/share/invite`

Returns a permanent link and LINE message payload for target picker.

### `POST /api/groups/:groupId/share/settlement`

Returns a permanent link and LINE message payload for settlement summary.
