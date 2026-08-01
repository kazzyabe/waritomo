const LINE_ID_TOKEN_VERIFY_ENDPOINT = "https://api.line.me/oauth2/v2.1/verify";

export class LineAuthError extends Error {
  constructor(message, statusCode = 401, details = undefined) {
    super(message);
    this.name = "LineAuthError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function getLineChannelId() {
  const channelId = process.env.LINE_CHANNEL_ID;
  if (!channelId) {
    throw new LineAuthError("LINE_CHANNEL_ID is not configured", 500);
  }
  return channelId;
}

export async function verifyLineIdToken(idToken, options = {}) {
  if (!idToken || typeof idToken !== "string") {
    throw new LineAuthError("idToken is required", 400);
  }

  const channelId = options.channelId ?? getLineChannelId();
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    id_token: idToken,
    client_id: channelId,
  });

  if (options.nonce) body.set("nonce", options.nonce);
  if (options.userId) body.set("user_id", options.userId);

  const response = await fetchImpl(LINE_ID_TOKEN_VERIFY_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const responseText = await response.text();
  const data = responseText ? JSON.parse(responseText) : {};

  if (!response.ok) {
    throw new LineAuthError("LINE ID token verification failed", response.status, data);
  }

  if (data.aud !== channelId) {
    throw new LineAuthError("LINE ID token audience does not match channel", 401);
  }

  if (!data.sub) {
    throw new LineAuthError("LINE ID token payload does not include sub", 401);
  }

  return data;
}

