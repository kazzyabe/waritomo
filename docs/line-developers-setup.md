# LINE Developers Setup

This app should start as a LINE mini app channel.

## 1. Create Channel

Create a LINE mini app channel in LINE Developers.

Do not create the production service as:

- LINE Login channel only
- Messaging API channel only
- LINE Login channel with a LIFF app attached

Those can still be useful for experiments, but the production target is a LINE
mini app channel.

## 2. Configure Web App

Set the endpoint URL to the Cloud Run custom domain:

```text
https://app.example.com
```

Avoid path-based endpoint roots for the MVP. Keeping the root clean makes
permanent link generation predictable.

## 3. Configure Environment

Set these in Cloud Run:

```text
PUBLIC_BASE_URL=https://app.example.com
LINE_LIFF_ID=1234567890-AbcdEfgh
LINE_MINIAPP_BASE_URL=https://miniapp.line.me/1234567890-AbcdEfgh
LINE_CHANNEL_ID=...
LINE_CHANNEL_SECRET=...
```

## 4. Permanent Link Rule

For a page:

```text
https://app.example.com/groups/grp_123/invite
```

Generate:

```text
https://miniapp.line.me/1234567890-AbcdEfgh/groups/grp_123/invite
```

Use this URL in invite messages and settlement sharing.

## 5. MVP Scopes

Start with:

- `openid`

Add later only when needed:

- `profile`
- `chat_message.write`

Prefer `liff.shareTargetPicker()` for user-initiated sharing before requesting
`chat_message.write`.

## 6. Auth Smoke Test

After Cloud Run deployment and endpoint URL setup:

1. Open `https://miniapp.line.me/{liffId}` in LINE.
2. Confirm the UI shows `LINE内で起動中`.
3. Confirm the UI shows `認証済み`.
4. Tap `セッション確認`.
5. Confirm `/api/me` returns the LINE-derived app user.

## 7. Review Preparation

Prepare before the first public release:

- privacy policy
- terms of use
- scope usage explanation
- test account and test scenario
- screenshots
- no third-party ad tags unless LINE mini app ad requirements are complete
