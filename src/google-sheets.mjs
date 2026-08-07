import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getUserAccessToken } from "./google-oauth.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_SPREADSHEET_ID = "1FvWVKQbRZpHtHS-30tr4lhPYNCC9QH8K0cIcbfd9wgU";
const DEFAULT_RANGE = "InProgress";
const DEFAULT_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbwRZlRSwHfwHUu_NrYQNeh6XOphstn5EJ-Rh9dqC6rj_fHW1t7CIqWJeSKAeUpWsxZT/exec";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function loadServiceAccount() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    return JSON.parse(inline);
  }

  const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (!path) {
    return null;
  }

  return JSON.parse(await readFile(path, "utf8"));
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: SHEETS_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer
    .sign(serviceAccount.private_key)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const assertion = `${header}.${payload}.${signature}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${text}`);
  }

  const json = await response.json();
  return json.access_token;
}

async function updateViaOAuth({ spreadsheetId, range, value }) {
  const accessToken = await getUserAccessToken();
  if (!accessToken) {
    return null;
  }

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
    `${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      range,
      majorDimension: "ROWS",
      values: [[value]],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets update failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function updateViaServiceAccount({ spreadsheetId, range, value }) {
  const serviceAccount = await loadServiceAccount();
  if (!serviceAccount) {
    throw new Error(
      "Google Sheets credentials not configured. Run scripts/oauth-setup.mjs after setting GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or set GOOGLE_SHEETS_WEBAPP_URL, or configure a service account.",
    );
  }

  const accessToken = await getAccessToken(serviceAccount);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
    `${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      range,
      majorDimension: "ROWS",
      values: [[value]],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets update failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function fetchWebAppText(urlString) {
  if (process.platform === "win32") {
    try {
      const curlPath = process.env.CURL_PATH || "C:\\Windows\\System32\\curl.exe";
      const { stdout } = await execFileAsync(curlPath, ["-sL", urlString], {
        windowsHide: true,
      });
      return stdout;
    } catch {
      // Fall through to fetch below.
    }
  }

  try {
    const response = await fetch(urlString, { method: "GET", redirect: "follow" });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Apps Script web app failed (${response.status}): ${text}`);
    }
    return text;
  } catch (err) {
    const causeCode = err && typeof err === "object" && "cause" in err ? err.cause?.code : "";
    const message = err instanceof Error ? err.message : String(err);
    const shouldUseCurlFallback =
      process.platform === "win32" &&
      (causeCode === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
        message.includes("certificate") ||
        message.includes("UNABLE_TO_GET_ISSUER_CERT") ||
        message === "fetch failed");

    if (!shouldUseCurlFallback) {
      throw err;
    }

    const curlPath = process.env.CURL_PATH || "C:\\Windows\\System32\\curl.exe";
    const { stdout } = await execFileAsync(curlPath, ["-sL", urlString], {
      windowsHide: true,
    });
    return stdout;
  }
}

async function callWebApp(params = {}) {
  const webAppUrl = process.env.GOOGLE_SHEETS_WEBAPP_URL || DEFAULT_WEBAPP_URL;
  const url = new URL(webAppUrl);

  for (const [key, paramValue] of Object.entries(params)) {
    if (paramValue !== undefined && paramValue !== null) {
      url.searchParams.set(key, String(paramValue));
    }
  }

  const text = await fetchWebAppText(url.toString());

  try {
    return JSON.parse(text);
  } catch {
    return { success: true, raw: text };
  }
}

async function updateViaWebApp({ value, action = "set_inprogress" }) {
  return callWebApp({ action, value });
}

export async function setInProgress(value = 1) {
  const spreadsheetId =
    process.env.GOOGLE_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
  const range = process.env.GOOGLE_IN_PROGRESS_RANGE || DEFAULT_RANGE;

  const webAppResult = await updateViaWebApp({ value, action: "set_inprogress" });
  if (webAppResult) {
    return { method: "webapp", spreadsheetId, range, value, result: webAppResult };
  }

  const oauthResult = await updateViaOAuth({ spreadsheetId, range, value });
  if (oauthResult) {
    return { method: "oauth", spreadsheetId, range, value, result: oauthResult };
  }

  const apiResult = await updateViaServiceAccount({
    spreadsheetId,
    range,
    value,
  });

  return { method: "service-account", spreadsheetId, range, value, result: apiResult };
}

export async function updateTarget(value) {
  const spreadsheetId =
    process.env.GOOGLE_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;

  const webAppResult = await callWebApp({
    action: "update_target",
    value,
  });

  if (webAppResult?.success === false) {
    throw new Error(webAppResult.error || "Failed to update target in Google Sheet.");
  }

  return {
    method: "webapp",
    spreadsheetId,
    value,
    result: webAppResult,
  };
}
