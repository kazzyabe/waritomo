# LINE Mini App Notes

## Channel Strategy

This project is built as a LINE mini app from the beginning. Do not create the
production app as a generic LINE Login channel with a LIFF app attached.

Use a LINE mini app channel in LINE Developers and treat the LIFF SDK as the
runtime API used by the mini app.

Required console values:

- LINE mini app channel ID
- LINE mini app channel secret
- LIFF ID
- endpoint URL
- LIFF URL: `https://miniapp.line.me/{liffId}`

## LIFF Initialization

- Initialize LIFF on every page load.
- Configure the LINE Developers endpoint URL as a stable root such as
  `https://app.example.com/`.
- Do not rewrite or strip `liff.*` query parameters before `liff.init()` resolves.
- Send analytics page views only after `liff.init()` resolves, because initial
  redirect URLs can contain sensitive token data.

## Identity

Use LINE as the primary account identity. The backend should verify tokens with
LINE and derive the user from the verified subject. Do not accept `userId`,
display name, or picture URL directly from the frontend as trusted identity.

## Permissions

Recommended MVP scopes:

- `openid` for identity.
- `profile` only when the product actually needs display name or picture.

Request additional permissions at the moment of use, not immediately on app
launch.

## Sharing

Use mini app permanent links for group invite and settlement links.

Example mapping:

```text
Endpoint URL: https://app.example.com
LIFF URL:     https://miniapp.line.me/{liffId}
Page URL:     https://app.example.com/groups/abc123/settlement
Share URL:    https://miniapp.line.me/{liffId}/groups/abc123/settlement
```

Share flow:

1. Try `liff.shareTargetPicker()` if available.
2. Fall back to copying the permanent link.
3. For direct send from an opened chat, consider `liff.sendMessages()` later.

Do not share endpoint URLs like `https://app.example.com/groups/...` in LINE.
Generate `https://miniapp.line.me/{liffId}/groups/...` instead.

## Custom Path

Custom Path is a later production polish item. It is available only for verified
mini apps and requires an application. Until then, use the LIFF ID based mini app
URL.

## Talk Room IDs

Do not rely on LINE talk room IDs. `groupId` and `roomId` in LIFF context are
deprecated. This app should use its own group ID and invite link.

## Service Messages

Treat service messages as post-MVP. They are useful for confirmation-style
notifications, but policy and review constraints are stricter than normal sharing.

Safe candidates:

- group created confirmation
- settlement marked paid confirmation
- settlement confirmed confirmation

Avoid promotional, reminder-like, or pressure-oriented messages until the review
path is clear.

## Review Readiness

Before review, prepare:

- production and review channel endpoint parity
- privacy policy
- terms of use
- test scenario with example group and members
- explanation of acquired LINE scopes
- no third-party ad tags unless LINE mini app ad process is completed
