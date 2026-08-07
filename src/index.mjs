#!/usr/bin/env node
/**
 * Detect & Alert MCP server entry point.
 *
 * Transports:
 *   MCP_TRANSPORT=stdio  (default) — local subprocess for Cursor
 *   MCP_TRANSPORT=http   — Streamable HTTP for web deployment
 */

import { startHttpServer } from "./http.mjs";
import { startStdioServer } from "./stdio.mjs";

const transport = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

async function main() {
  if (transport === "http") {
    await startHttpServer();
    return;
  }

  if (transport === "stdio") {
    await startStdioServer();
    return;
  }

  throw new Error(`Unknown MCP_TRANSPORT: ${transport}. Use "stdio" or "http".`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
