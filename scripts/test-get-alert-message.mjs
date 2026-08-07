import { extractAccountValuesById, fetchAlertAccountValues } from "../src/planning-mcp-client.mjs";
import { handleRequest } from "../src/core.mjs";

const reportData = {
  rows: [
    {
      cells: [
        { colIndex: 0, value: "45500801.53680761" },
        { colIndex: 1, value: "45399999.999999985" },
      ],
    },
  ],
  columns: [
    { coordinates: [{ dimensionType: "acct", elementId: "1307" }] },
    { coordinates: [{ dimensionType: "acct", elementId: "2943" }] },
  ],
};

const values = extractAccountValuesById(reportData, {
  operatingExpenses: "1307",
  expenseTarget: "2943",
});

if (values.operatingExpenses !== 45500801.53680761) {
  throw new Error(`Unexpected operating expenses value: ${values.operatingExpenses}`);
}

if (values.expenseTarget !== 45399999.999999985) {
  throw new Error(`Unexpected expense target value: ${values.expenseTarget}`);
}

console.log("extractAccountValuesById:", values);

if (process.argv.includes("--live-planning")) {
  const liveValues = await fetchAlertAccountValues();
  console.log("fetchAlertAccountValues:", liveValues);
}

if (process.argv.includes("--live-tool")) {
  const response = await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_alert_message", arguments: {} },
  });

  console.log(response.result.content[0].text);
}
