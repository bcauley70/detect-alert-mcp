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

function findMetadataMatch(searchResults, keyword, metadataType) {
  const dimension = searchResults.find((entry) => entry.metadata_type === metadataType);
  if (dimension?.values?.length) {
    const normalizedKeyword = normalizeLabel(keyword);
    const match = dimension.values.find((value) => {
      const candidates = [value.name, value.code];
      return candidates.some((candidate) => normalizeLabel(candidate) === normalizedKeyword);
    });

    if (match) {
      return match;
    }
  }

  const flatMatch = searchResults
    .flatMap((item) => item.results || [])
    .find(
      (result) =>
        result.metadata_type === metadataType &&
        normalizeLabel(result.name || result.code || "").includes(normalizeLabel(keyword)),
    );

  if (flatMatch) {
    return flatMatch;
  }

  return null;
}

function parseOnlyLevel(levelName) {
  const match = String(levelName || "").match(/^(.+?)\s*\((only|uncategorized)\)\s*$/i);
  if (!match) {
    return { baseLevel: levelName, useOnlySlot: false };
  }

  return { baseLevel: match[1].trim(), useOnlySlot: true };
}

function levelIdForWrite(levelMatch, { useOnlySlot = false } = {}) {
  if (!levelMatch?.id) {
    return null;
  }

  if (useOnlySlot || levelMatch.has_children) {
    return `-${levelMatch.id}`;
  }

  return String(levelMatch.id);
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function fiscalYearFromTimeLabel(timeLabel) {
  const match = String(timeLabel || "").match(/(\d{4})/);
  if (!match) {
    throw new Error(`Could not parse fiscal year from time label: ${timeLabel}`);
  }

  return Number(match[1]);
}

function monthLabelsForFiscalYear(year) {
  return MONTH_NAMES.map((month) => `${month} ${year}`);
}

async function resolveMonthlyTimeIds(timeLabel) {
  const year = fiscalYearFromTimeLabel(timeLabel);
  const labels = monthLabelsForFiscalYear(year);
  const searchResults = await searchPlanningMetadata(labels);
  const timeDimension = searchResults.find((entry) => entry.metadata_type === 3);

  if (!timeDimension?.values?.length) {
    throw new Error(`Could not resolve monthly time periods for ${timeLabel}.`);
  }

  const months = labels.map((label) => {
    const match = timeDimension.values.find((value) => value.name === label);
    if (!match?.id) {
      throw new Error(`Could not resolve monthly time period: ${label}`);
    }

    return {
      label,
      timeId: String(match.id),
    };
  });

  return months;
}

function timeCoordinateFromRow(row) {
  return (row.coordinates || []).find(
    (coordinate) =>
      coordinate.dimensionType === "time" ||
      coordinate.type === "time" ||
      coordinate.dimensionName === "Time",
  );
}

function parsePlanningQueryPayload(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unable to parse planning query response: ${text.slice(0, 300)}`);
  }
}

export async function fetchMonthlyTargetValues(ids, monthlyTimeIds) {
  const result = await callPlanningTool("data-dimensional-query", {
    request: {
      options: {
        suppressZeroes: 0,
        includeLabels: true,
        includeElementCode: true,
      },
      axes: [
        {
          type: "X",
          segments: [
            {
              tiers: [
                {
                  type: "account",
                  elements: [{ id: String(ids.accountId) }],
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
                  elements: monthlyTimeIds.map((month) => ({ id: month.timeId })),
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

  const payload = parsePlanningQueryPayload(toolText(result));
  const rows = payload?.reportData?.rows || payload?.rows || [];
  const valuesByTimeId = new Map();

  for (const row of rows) {
    const timeCoordinate = timeCoordinateFromRow(row);
    const timeId = timeCoordinate?.elementId ? String(timeCoordinate.elementId) : null;
    if (!timeId) {
      continue;
    }

    valuesByTimeId.set(timeId, parseNumericValue(row.cells?.[0]?.value ?? row.cells?.[0]?.formatted));
  }

  return monthlyTimeIds.map((month) => ({
    ...month,
    value: valuesByTimeId.get(month.timeId) ?? 0,
  }));
}

export function prorateMonthlyValues(monthlyValues, newTarget) {
  if (!Array.isArray(monthlyValues) || monthlyValues.length === 0) {
    throw new Error("No monthly values available to prorate.");
  }

  const numericTarget = Number(newTarget);
  if (!Number.isFinite(numericTarget)) {
    throw new Error("New target value must be a valid number.");
  }

  const priorTotal = monthlyValues.reduce((sum, month) => sum + month.value, 0);
  let prorated;

  if (priorTotal === 0) {
    const evenValue = Math.floor(numericTarget / monthlyValues.length);
    prorated = monthlyValues.map((month, index) => ({
      ...month,
      value:
        index === monthlyValues.length - 1
          ? numericTarget - evenValue * (monthlyValues.length - 1)
          : evenValue,
    }));
  } else {
    prorated = monthlyValues.map((month) => ({
      ...month,
      value: Math.round((numericTarget * month.value) / priorTotal),
    }));

    const roundingDiff = numericTarget - prorated.reduce((sum, month) => sum + month.value, 0);
    prorated[prorated.length - 1].value += roundingDiff;
  }

  return {
    priorTotal,
    newTotal: numericTarget,
    prorated,
  };
}

export function buildProratedTargetWriteRequest(proratedMonths, ids) {
  return {
    dimensionSets: [
      {
        dimension: { typeId: "-9", code: "Currency" },
        dimensionMembers: [{ id: String(ids.currencyId) }],
      },
      {
        dimension: { typeId: "-4", code: "Version" },
        dimensionMembers: [{ id: String(ids.versionId) }],
      },
      {
        dimension: { typeId: "-3", code: "Time" },
        dimensionMembers: proratedMonths.map((month) => ({ id: String(month.timeId) })),
      },
      {
        dimension: { typeId: "-2", code: "Account" },
        dimensionMembers: [{ id: String(ids.accountId) }],
      },
      {
        dimension: { typeId: "-1", code: "Level" },
        dimensionMembers: [{ id: String(ids.levelWriteId) }],
      },
    ],
    indexedCoordinates: proratedMonths.map((month, index) => ({
      c: [0, 0, index, 0, 0],
      v: String(month.value),
    })),
  };
}

export function buildTargetWriteRequest(value, ids) {
  return {
    dimensionSets: [
      {
        dimension: { typeId: "-9", code: "Currency" },
        dimensionMembers: [{ id: String(ids.currencyId) }],
      },
      {
        dimension: { typeId: "-4", code: "Version" },
        dimensionMembers: [{ id: String(ids.versionId) }],
      },
      {
        dimension: { typeId: "-3", code: "Time" },
        dimensionMembers: [{ id: String(ids.timeId) }],
      },
      {
        dimension: { typeId: "-2", code: "Account" },
        dimensionMembers: [{ id: String(ids.accountId) }],
      },
      {
        dimension: { typeId: "-1", code: "Level" },
        dimensionMembers: [{ id: String(ids.levelWriteId) }],
      },
    ],
    indexedCoordinates: [{ c: [0, 0, 0, 0, 0], v: String(value) }],
  };
}

export async function resolveTargetWriteIds({
  account = process.env.PLANNING_TARGET_ACCOUNT || "Expense_Target",
  version = process.env.PLANNING_VERSION || "Scenario 1",
  time = process.env.PLANNING_TIME || "FY2027",
  level =
    process.env.PLANNING_WRITE_LEVEL ||
    process.env.PLANNING_LEVEL ||
    "Total Company (Only)",
  currencyId = process.env.PLANNING_CURRENCY_ID || "15400",
} = {}) {
  const { baseLevel, useOnlySlot } = parseOnlyLevel(level);
  const searchResults = await searchPlanningMetadata([account, version, time, baseLevel]);

  const accountMatch = findMetadataMatch(searchResults, account, 2);
  const levelMatch = findMetadataMatch(searchResults, baseLevel, 1);
  const ids = {
    accountId: accountMatch?.id ?? null,
    versionId: findVersionOrScenarioId(searchResults, version),
    timeId: findMetadataId(searchResults, time, 3),
    levelId: levelMatch?.id ?? null,
    levelWriteId: levelIdForWrite(levelMatch, { useOnlySlot }),
    levelLabel: level,
    currencyId,
  };

  const missing = [
    ["account", account, ids.accountId],
    ["versionOrScenario", version, ids.versionId],
    ["time", time, ids.timeId],
    ["level", level, ids.levelId],
    ["levelWriteId", level, ids.levelWriteId],
  ]
    .filter(([, , id]) => !id)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Could not resolve planning metadata for: ${missing.join(", ")}`);
  }

  return ids;
}

export async function writeExpenseTarget(value, ids) {
  const timeLabel = process.env.PLANNING_TIME || "FY2027";
  const monthlyTimeIds = await resolveMonthlyTimeIds(timeLabel);
  const monthlyValues = await fetchMonthlyTargetValues(ids, monthlyTimeIds);
  const { priorTotal, newTotal, prorated } = prorateMonthlyValues(monthlyValues, value);
  const writeRequest = buildProratedTargetWriteRequest(prorated, ids);
  const result = await callPlanningTool("data-dimensional-write", {
    writeRequestPayload: JSON.stringify(writeRequest),
  });
  const text = toolText(result);

  if (!text || /error writing hypercube data/i.test(text)) {
    throw new Error(text || "Planning write returned an empty response.");
  }

  return {
    writeRequest,
    response: text,
    priorTotal,
    newTotal,
    priorMonthlyValues: monthlyValues,
    monthlyValues: prorated,
  };
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

export function extractAccountValuesById(reportData, accountIdsByKey) {
  const columns = reportData?.columns || [];
  const row = reportData?.rows?.[0];
  const values = {};

  for (const key of Object.keys(accountIdsByKey)) {
    values[key] = null;
  }

  if (!row) {
    return values;
  }

  for (const cell of row.cells || []) {
    const column = Number.isInteger(cell.colIndex) ? columns[cell.colIndex] : null;
    const accountCoordinate = (column?.coordinates || []).find(
      (coordinate) => coordinate.dimensionType === "acct",
    );
    const accountId = accountCoordinate?.elementId
      ? String(accountCoordinate.elementId)
      : null;

    if (!accountId) {
      continue;
    }

    for (const [key, expectedId] of Object.entries(accountIdsByKey)) {
      if (String(expectedId) === accountId) {
        values[key] = parseNumericValue(cell.value ?? cell.formatted);
      }
    }
  }

  return values;
}

export async function fetchAlertAccountValues({
  operatingExpensesAccount =
    process.env.PLANNING_OPERATING_EXPENSES_ACCOUNT || "6000_Operating_Expenses",
  targetAccount = process.env.PLANNING_TARGET_ACCOUNT || "Expense_Target",
  version = process.env.PLANNING_VERSION || "Scenario 1",
  time = process.env.PLANNING_TIME || "FY2027",
  level = process.env.PLANNING_LEVEL || "Total Company",
} = {}) {
  const searchResults = await searchPlanningMetadata([
    operatingExpensesAccount,
    targetAccount,
    version,
    time,
    level,
  ]);

  const operatingMatch = findMetadataMatch(searchResults, operatingExpensesAccount, 2);
  const targetMatch = findMetadataMatch(searchResults, targetAccount, 2);
  const versionId = findVersionOrScenarioId(searchResults, version);
  const timeId = findMetadataId(searchResults, time, 3);
  const levelId = findMetadataId(searchResults, level, 1);

  const missing = [
    ["operatingExpensesAccount", operatingExpensesAccount, operatingMatch?.id],
    ["targetAccount", targetAccount, targetMatch?.id],
    ["versionOrScenario", version, versionId],
    ["time", time, timeId],
    ["level", level, levelId],
  ]
    .filter(([, , id]) => !id)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Could not resolve planning metadata for alert query: ${missing.join(", ")}`);
  }

  const result = await callPlanningTool("data-dimensional-query", {
    request: {
      options: {
        suppressZeroes: 0,
        includeLabels: true,
        includeElementCode: true,
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
                    { id: String(operatingMatch.id) },
                    { id: String(targetMatch.id) },
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
                  elements: [{ id: String(timeId) }],
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
                  elements: [{ id: String(versionId) }],
                },
                {
                  type: "level",
                  elements: [{ id: String(levelId) }],
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const payload = parsePlanningQueryPayload(toolText(result));
  const reportData = payload?.reportData || payload;
  const values = extractAccountValuesById(reportData, {
    operatingExpenses: operatingMatch.id,
    expenseTarget: targetMatch.id,
  });

  return {
    operatingExpenses: values.operatingExpenses ?? 0,
    expenseTarget: values.expenseTarget ?? 0,
  };
}

function formatPlanningAmount(value) {
  return Math.round(Number(value)).toLocaleString("en-US");
}

function formatPercentChange(priorTotal, newTotal) {
  if (!priorTotal) {
    return "n/a";
  }

  const pct = ((newTotal - priorTotal) / priorTotal) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function summarizeLargestMonthlyChange(priorMonthlyValues, monthlyValues) {
  if (!priorMonthlyValues?.length || !monthlyValues?.length) {
    return null;
  }

  const changes = monthlyValues.map((month, index) => ({
    label: month.label,
    delta: month.value - (priorMonthlyValues[index]?.value ?? 0),
  }));

  if (!changes.length) {
    return null;
  }

  return changes.reduce((largest, change) =>
    Math.abs(change.delta) > Math.abs(largest.delta) ? change : largest,
  );
}

function formatVarianceLine(item) {
  if (item?.variance !== undefined && item?.variance !== null) {
    const coordinates =
      item.coordinates && typeof item.coordinates === "object"
        ? Object.entries(item.coordinates)
            .map(([key, value]) => `${key}: ${value}`)
            .join(", ")
        : String(item.coordinates || "variance cell");

    return `${coordinates} — ${formatPlanningAmount(item.variance)}`;
  }

  if (item?.accountName || item?.elementName) {
    const label = item.accountName || item.elementName;
    const amount = item.variance ?? item.value ?? item.amount;
    return `${label} — ${formatPlanningAmount(amount)}`;
  }

  return JSON.stringify(item);
}

async function tryGetTopVariances({
  versionId,
  baseVersionId,
  timeId,
  levelId,
  accountIds,
}) {
  if (!versionId || !baseVersionId || !timeId || !levelId || !accountIds?.length) {
    return null;
  }

  try {
    const result = await callPlanningTool("get_top_variances", {
      relevantDimensionDetails: [
        {
          dimensionKey: { id: -2, type: "ACCOUNT" },
          dimensionName: "Account",
          members: accountIds.map((id) => ({ id: Number(id), isUncat: false })),
          operators: [],
        },
        {
          dimensionKey: { id: -1, type: "LEVEL" },
          dimensionName: "Level",
          members: [{ id: Number(levelId), isUncat: false }],
          operators: [],
        },
        {
          dimensionKey: { id: -3, type: "TIME" },
          dimensionName: "Time",
          members: [{ id: Number(timeId), isUncat: false }],
          operators: [],
        },
        {
          dimensionKey: { id: -4, type: "VERSION" },
          dimensionName: "Version",
          members: [
            { id: Number(versionId), isUncat: false },
            { id: Number(baseVersionId), isUncat: false },
          ],
          operators: [],
        },
      ],
      topN: 3,
      thresholdValue: 1000,
    });
    const text = toolText(result);
    if (!text) {
      return null;
    }

    const payload = JSON.parse(text);
    if (!payload.success) {
      return null;
    }

    return payload.varianceData || payload;
  } catch {
    return null;
  }
}

export async function buildTargetUpdateAnalysis(planningResult, ids) {
  const lines = [];
  const {
    priorTotal,
    newTotal,
    priorMonthlyValues,
    monthlyValues,
  } = planningResult;
  const delta = newTotal - priorTotal;
  const deltaLabel = `${delta >= 0 ? "+" : ""}${formatPlanningAmount(delta)}`;

  lines.push(
    `Expense_Target FY total: ${formatPlanningAmount(priorTotal)} -> ${formatPlanningAmount(newTotal)} (${deltaLabel}, ${formatPercentChange(priorTotal, newTotal)}).`,
  );
  lines.push(
    `Prorated ${monthlyValues.length} monthly values in ${process.env.PLANNING_VERSION || "Scenario 1"} at ${ids.levelLabel}.`,
  );

  const largestChange = summarizeLargestMonthlyChange(priorMonthlyValues, monthlyValues);
  if (largestChange) {
    const sign = largestChange.delta >= 0 ? "+" : "";
    lines.push(
      `Largest monthly change: ${largestChange.label} (${sign}${formatPlanningAmount(largestChange.delta)}).`,
    );
  }

  const accounts = await fetchAlertAccountValues();
  const gap = accounts.operatingExpenses - accounts.expenseTarget;
  const gapLabel = gap > 0 ? "over target" : gap < 0 ? "under target" : "on target";
  lines.push(
    `Current plan vs target: ${formatPlanningAmount(accounts.operatingExpenses)} operating expenses vs ${formatPlanningAmount(accounts.expenseTarget)} target (${formatPlanningAmount(Math.abs(gap))} ${gapLabel}).`,
  );

  const baseVersion = process.env.PLANNING_BASE_VERSION || "Working Budget";
  const operatingAccount =
    process.env.PLANNING_OPERATING_EXPENSES_ACCOUNT || "6000_Operating_Expenses";
  const metadata = await searchPlanningMetadata([baseVersion, operatingAccount]);
  const baseVersionId = findVersionOrScenarioId(metadata, baseVersion);
  const operatingAccountId = findMetadataId(metadata, operatingAccount, 2);
  const variances = await tryGetTopVariances({
    versionId: ids.versionId,
    baseVersionId,
    timeId: ids.timeId,
    levelId: ids.levelId,
    accountIds: [operatingAccountId, ids.accountId].filter(Boolean),
  });

  if (variances?.variances?.length) {
    lines.push("Top variances (Scenario 1 vs Working Budget):");
    for (const item of variances.variances.slice(0, 3)) {
      lines.push(`- ${formatVarianceLine(item)}`);
    }
  } else {
    lines.push(
      "Variance reporting is unavailable on this tenant; analysis uses the updated target totals and current plan values.",
    );
  }

  return lines.join("\n");
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
