import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  handleRequest,
  isJsonRpcNotification,
  isJsonRpcRequest,
  SERVER_INFO,
} from "./core.mjs";

const MCP_PATH = process.env.MCP_PATH || "/mcp";
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.MCP_API_KEY || "";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function unauthorized(res) {
  sendJson(res, 401, {
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
  });
}

function isAuthorized(req) {
  if (!API_KEY) return true;

  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${API_KEY}`) return true;

  const apiKey = req.headers["x-api-key"];
  return apiKey === API_KEY;
}

function normalizeMessages(body) {
  if (!body) return [];
  return Array.isArray(body) ? body : [body];
}

async function handleMcpPost(req, res) {
  if (!isAuthorized(req)) {
    unauthorized(res);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  const messages = normalizeMessages(body);
  if (messages.length === 0) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request" },
    });
    return;
  }

  const requests = messages.filter(isJsonRpcRequest);
  const notifications = messages.filter(isJsonRpcNotification);

  for (const notification of notifications) {
    await handleRequest(notification);
  }

  if (requests.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }

  const responses = [];
  for (const request of requests) {
    const response = await handleRequest(request);
    if (response) responses.push(response);
  }

  const headers = {};
  const initResponse = responses.find((r) => r.result?.protocolVersion);
  if (initResponse) {
    headers["Mcp-Session-Id"] = randomUUID();
  }

  if (responses.length === 1) {
    sendJson(res, 200, responses[0], headers);
    return;
  }

  sendJson(res, 200, responses, headers);
}

function handleMcpGet(_req, res) {
  res.writeHead(405, { Allow: "POST" });
  res.end();
}

function handleHealth(_req, res) {
  sendJson(res, 200, {
    status: "ok",
    server: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: "streamable-http",
    endpoint: MCP_PATH,
  });
}

function handleRoot(_req, res) {
  sendJson(res, 200, {
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    mcp: MCP_PATH,
    health: "/health",
    docs: "https://modelcontextprotocol.io",
  });
}

export async function startHttpServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key, Accept, Mcp-Session-Id, MCP-Protocol-Version",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (path === "/health" && req.method === "GET") {
        handleHealth(req, res);
        return;
      }

      if (path === "/" && req.method === "GET") {
        handleRoot(req, res);
        return;
      }

      if (path === MCP_PATH && req.method === "POST") {
        await handleMcpPost(req, res);
        return;
      }

      if (path === MCP_PATH && req.method === "GET") {
        handleMcpGet(req, res);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal error",
        },
      });
    }
  });

  await new Promise((resolve) => {
    server.listen(PORT, HOST, resolve);
  });

  const authNote = API_KEY ? " (API key required)" : "";
  process.stderr.write(
    `Detect & Alert HTTP server listening on http://${HOST}:${PORT}${MCP_PATH}${authNote}\n`,
  );

  return server;
}
