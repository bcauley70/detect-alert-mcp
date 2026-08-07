import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_TOKEN_PATH = join(
  homedir(),
  ".config",
  "detect-alert",
  "google-oauth-token.json",
);

export function getTokenPath() {
  return process.env.GOOGLE_OAUTH_TOKEN_PATH || DEFAULT_TOKEN_PATH;
}

export function getOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
}

export async function loadStoredToken() {
  const inline = process.env.GOOGLE_REFRESH_TOKEN;
  const config = getOAuthConfig();
  if (inline && config) {
    return {
      refresh_token: inline,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    };
  }

  try {
    return JSON.parse(await readFile(getTokenPath(), "utf8"));
  } catch {
    return null;
  }
}

export async function saveStoredToken(token) {
  const path = getTokenPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(token, null, 2), "utf8");
  return path;
}

export async function getUserAccessToken() {
  const stored = await loadStoredToken();
  if (!stored?.refresh_token) {
    return null;
  }

  const clientId = stored.client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = stored.client_secret || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth refresh token found but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing.",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: stored.refresh_token,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth refresh failed (${response.status}): ${text}`);
  }

  const json = await response.json();
  return json.access_token;
}

export function buildAuthorizationUrl({ clientId, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SHEETS_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth code exchange failed (${response.status}): ${text}`);
  }

  return response.json();
}
