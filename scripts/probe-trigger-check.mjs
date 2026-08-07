import fs from "node:fs";

const proxyUrl = process.env.PLANNING_MCP_URL || "http://127.0.0.1:39281/mcp";
const apiKey = process.env.PLANNING_MCP_API_KEY || "sana-demo-key-2026";

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  Accept: "text/event-stream, application/json",
};

async function mcpCall(method, params, sessionId) {
  const callHeaders = { ...headers };
  if (sessionId) callHeaders["Mcp-Session-Id"] = sessionId;

  const res = await fetch(proxyUrl, {
    method: "POST",
    headers: callHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  const payload = dataLine ? JSON.parse(dataLine.slice(5)) : JSON.parse(text);
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return { payload, sessionId: sessionId || res.headers.get("mcp-session-id") };
}

const init = await mcpCall("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "trigger-probe", version: "1.0.0" },
});
let sessionId = init.sessionId;

const search = await mcpCall(
  "tools/call",
  {
    name: "metadata-search-by-term",
    arguments: {
      keywords: [
        "Detect_and_Alert_Triggers",
        "Working Budget",
        "FY2027",
        "Top Level",
      ],
    },
  },
  sessionId,
);
console.log("search:", JSON.stringify(search.payload.result, null, 2).slice(0, 4000));

const searchText = search.payload.result?.content?.[0]?.text || "";
const searchData = JSON.parse(searchText);

function findId(keyword, metadataType) {
  const entry = searchData.find(
    (item) =>
      item.keyword?.toLowerCase() === keyword.toLowerCase() &&
      item.results?.some((r) => r.metadata_type === metadataType),
  );
  const result = entry?.results?.find((r) => r.metadata_type === metadataType);
  return result?.id;
}

const parentAccountId = findId("Detect_and_Alert_Triggers", 2);
const versionId = findId("Working Budget", 4);
const timeId = findId("FY2027", 3);
const levelId = findId("Top Level", 1);

console.log({ parentAccountId, versionId, timeId, levelId });

const query = await mcpCall(
  "tools/call",
  {
    name: "data-dimensional-query",
    arguments: {
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
                      { id: String(parentAccountId), rollupMode: "C" },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "Y",
            segments: [{ tiers: [{ type: "time", elements: [{ id: String(timeId) }] }] }],
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
    },
  },
  sessionId,
);

const queryText = query.payload.result?.content?.[0]?.text || "";
fs.writeFileSync("C:/Users/brian.cauley/AppData/Local/Temp/trigger-query.json", queryText);
console.log(queryText.slice(0, 3000));
