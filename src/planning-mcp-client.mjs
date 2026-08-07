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
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    try {
      const payload = JSON.parse(dataLines[index]);
      if (payload.result !== undefined || payload.error !== undefined) {
        return payload;
      }
    } catch {
      // Try the previous data line.
    }
  }

  if (dataLines.length === 0) {
    return JSON.parse(text);
  }

  return JSON.parse(dataLines[dataLines.length - 1]);
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
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (Array.isArray(parsed.matched_dimensions_or_values)) {
      return parsed.matched_dimensions_or_values;
    }

    return [];
  } catch {
    throw new Error(`Unable to parse metadata search response: ${text.slice(0, 300)}`);
  }
}

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[_\s]+/g, "");
}

function findValueInDimensionEntries(entries, metadataType, label) {
  const dimension = entries.find((entry) => entry.metadata_type === metadataType);
  if (!dimension?.values?.length) {
    return null;
  }

  const normalizedLabel = normalizeLabel(label);
  const match = dimension.values.find((value) => {
    const candidates = [value.name, value.code];
    return candidates.some((candidate) => normalizeLabel(candidate) === normalizedLabel);
  });

  return match?.id ?? null;
}

function findMetadataId(searchResults, keyword, metadataType) {
  const fromDimensions = findValueInDimensionEntries(
    searchResults,
    metadataType,
    keyword,
  );
  if (fromDimensions) {
    return fromDimensions;
  }

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
          normalizeLabel(result.name || result.code || "").includes(
            normalizeLabel(keyword),
          ),
      );

  return match?.id ?? null;
}

function findVersionOrScenarioId(searchResults, keyword) {
  return (
    findMetadataId(searchResults, keyword, 4) ||
    findMetadataId(searchResults, keyword, 15)
  );
}

export async function resolveTriggerQueryIds({
  parentAccount = process.env.PLANNING_PARENT_ACCOUNT || "Detect & Alert Triggers",
  version = process.env.PLANNING_VERSION || "Scenario 1",
  time = process.env.PLANNING_TIME || "FY2027",
  level = process.env.PLANNING_LEVEL || "Total Company",
} = {}) {
  const searchResults = await searchPlanningMetadata([
    parentAccount,
    version,
    time,
    level,
  ]);

  const ids = {
    parentAccountId: findMetadataId(searchResults, parentAccount, 2),
    versionId: findVersionOrScenarioId(searchResults, version),
    timeId: findMetadataId(searchResults, time, 3),
    levelId: findMetadataId(searchResults, level, 1),
  };

  const missing = [
    ["parentAccount", parentAccount, ids.parentAccountId],
    ["versionOrScenario", version, ids.versionId],
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
  const accountCoordinate = (column?.coordinates || []).find(
    (coordinate) =>
      coordinate.dimensionType === "acct" ||
      coordinate.type === "account" ||
      coordinate.dimensionName === "Account",
  );

  if (accountCoordinate) {
    return accountNameFromCoordinate(accountCoordinate);
  }

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
