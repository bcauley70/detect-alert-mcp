const DEFAULT_PLANNING_MCP_URL = "https://workday-planning-mcp.onrender.com/mcp";

let sessionId = null;
let requestId = 0;

function planningConfig() {
  return {
    url: process.env.PLANNING_MCP_URL || DEFAULT_PLANNING_MCP_URL,
    apiKey: process.env.PLANNING_MCP_API_KEY || "",
  };
}

function parseMcpResponse(text) {
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  if (dataLine) {
    return JSON.parse(dataLine.slice(5).trim());
  }

  return JSON.parse(text);
}

function toolText(result) {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }

  return content.map((item) => item.text || "").join("\n");
}

async function mcpRequest(method, params = {}) {
  const { url, apiKey } = planningConfig();
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method,
      params,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Planning MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const payload = parseMcpResponse(text);
  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error));
  }

  if (method === "initialize") {
    sessionId = response.headers.get("mcp-session-id") || sessionId;
  }

  return payload.result;
}

async function ensureSession() {
  if (sessionId) {
    return;
  }

  await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "detect-alert-monitor", version: "1.2.0" },
  });
}

export async function callPlanningTool(name, args = {}) {
  await ensureSession();
  const result = await mcpRequest("tools/call", { name, arguments: args });
  return result;
}

export async function searchPlanningMetadata(keywords) {
  const result = await callPlanningTool("metadata-search-by-term", { keywords });
  const text = toolText(result);
  if (!text) {
    return [];
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unable to parse metadata search response: ${text.slice(0, 300)}`);
  }
}

function findMetadataId(searchResults, keyword, metadataType) {
  const entry = searchResults.find(
    (item) =>
      String(item.keyword || "").toLowerCase() === keyword.toLowerCase() &&
      Array.isArray(item.results),
  );

  const match =
    entry?.results?.find((result) => result.metadata_type === metadataType) ||
    searchResults
      .flatMap((item) => item.results || [])
      .find(
        (result) =>
          result.metadata_type === metadataType &&
          String(result.name || result.code || "")
            .toLowerCase()
            .includes(keyword.toLowerCase()),
      );

  return match?.id ?? null;
}

export async function resolveTriggerQueryIds({
  parentAccount = process.env.PLANNING_PARENT_ACCOUNT || "Detect_and_Alert_Triggers",
  version = process.env.PLANNING_VERSION || "Working Budget",
  time = process.env.PLANNING_TIME || "FY2027",
  level = process.env.PLANNING_LEVEL || "Top Level",
} = {}) {
  const searchResults = await searchPlanningMetadata([
    parentAccount,
    version,
    time,
    level,
  ]);

  const ids = {
    parentAccountId: findMetadataId(searchResults, parentAccount, 2),
    versionId: findMetadataId(searchResults, version, 4),
    timeId: findMetadataId(searchResults, time, 3),
    levelId: findMetadataId(searchResults, level, 1),
  };

  const missing = [
    ["parentAccount", parentAccount, ids.parentAccountId],
    ["version", version, ids.versionId],
    ["time", time, ids.timeId],
    ["level", level, ids.levelId],
  ]
    .filter(([, , id]) => !id)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Could not resolve planning metadata for: ${missing.join(", ")}`);
  }

  return ids;
}

function parseNumericValue(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const normalized = String(value).replace(/,/g, "").replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountNameFromCoordinate(coordinate) {
  return (
    coordinate?.elementName ||
    coordinate?.name ||
    coordinate?.elementCode ||
    coordinate?.code ||
    null
  );
}

function accountNameFromColumn(column) {
  return column?.elementName || column?.name || column?.elementCode || column?.code || null;
}

export function extractNonZeroChildAccounts(reportData) {
  const rows = reportData?.rows || [];
  const columns = reportData?.columns || [];
  const matches = [];

  for (const row of rows) {
    const accountCoordinate = (row.coordinates || []).find(
      (coordinate) =>
        coordinate.dimensionType === "acct" ||
        coordinate.type === "account" ||
        coordinate.dimensionName === "Account",
    );

    for (const cell of row.cells || []) {
      const numericValue = parseNumericValue(cell.value ?? cell.formatted);
      if (numericValue === 0) {
        continue;
      }

      let accountName = accountNameFromCoordinate(accountCoordinate);
      if (!accountName && Number.isInteger(cell.colIndex) && columns[cell.colIndex]) {
        accountName = accountNameFromColumn(columns[cell.colIndex]);
      }

      if (accountName) {
        matches.push({ accountName, value: numericValue });
      }
    }
  }

  if (matches.length === 0 && columns.length > 0 && rows.length > 0) {
    const row = rows[0];
    for (const cell of row.cells || []) {
      const numericValue = parseNumericValue(cell.value ?? cell.formatted);
      if (numericValue === 0) {
        continue;
      }

      const column =
        Number.isInteger(cell.colIndex) && columns[cell.colIndex]
          ? columns[cell.colIndex]
          : columns[cell.index] || columns[matches.length];

      const accountName = accountNameFromColumn(column);
      if (accountName) {
        matches.push({ accountName, value: numericValue });
      }
    }
  }

  const deduped = new Map();
  for (const match of matches) {
    if (!deduped.has(match.accountName)) {
      deduped.set(match.accountName, match);
    }
  }

  return [...deduped.values()];
}

export async function findTriggeredChildAccounts(ids) {
  const result = await callPlanningTool("data-dimensional-query", {
    request: {
      options: {
        suppressZeroes: 0,
        includeLabels: true,
        includeElementCode: true,
        includeCoordDepth: true,
      },
      axes: [
        {
          type: "X",
          segments: [
            {
              tiers: [
                {
                  type: "account",
                  elements: [
                    {
                      id: String(ids.parentAccountId),
                      rollupMode: "C",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "Y",
          segments: [
            {
              tiers: [
                {
                  type: "time",
                  elements: [{ id: String(ids.timeId) }],
                },
              ],
            },
          ],
        },
        {
          type: "FILTER",
          segments: [
            {
              tiers: [
                {
                  type: "version",
                  elements: [{ id: String(ids.versionId) }],
                },
                {
                  type: "level",
                  elements: [{ id: String(ids.levelId) }],
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const text = toolText(result);
  if (!text) {
    return [];
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Unable to parse planning query response: ${text.slice(0, 300)}`);
  }

  return extractNonZeroChildAccounts(payload.reportData || payload);
}
