import { getTrigger, setInProgress, updateTarget } from "./google-sheets.mjs";
import {
  fetchAlertAccountValues,
  resolveTargetWriteIds,
  writeExpenseTarget,
} from "./planning-mcp-client.mjs";
import {
  getTriggerMonitorStatus,
  runTriggerCheck,
  setTriggerCheckInterval,
  startTriggerMonitor,
  stopTriggerMonitor,
} from "./trigger-monitor.mjs";

export const SERVER_INFO = { name: "Detect & Alert", version: "1.2.4" };
export const PROTOCOL_VERSION = "2024-11-05";

function formatAlertAmount(value) {
  return Math.round(Number(value)).toLocaleString("en-US");
}

async function buildAlertMessage(triggerValue) {
  const { operatingExpenses, expenseTarget } = await fetchAlertAccountValues();

  return [
    `Alert condition triggered - ${triggerValue}`,
    `The current plan is ${formatAlertAmount(operatingExpenses)} against a plan of ${formatAlertAmount(expenseTarget)}`,
    "Would you like to adjust the target?",
  ].join("\n");
}

const TOOLS = [
  {
    name: "get_alert_message",
    description:
      "Get Alert Message. Reads the Trigger named range, sets InProgress to 1, queries Adaptive Planning for 6000_Operating_Expenses and Expense_Target at Scenario 1 / Total Company / FY2027, and returns the alert text.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_target",
    description:
      "Update Target. Reads existing monthly Expense_Target values for FY2027, prorates the new annual target across those months, writes them back to Adaptive Planning (Scenario 1 / Working Budget, Total Company (Only)), then updates the Google Sheet Target range and clears Trigger and InProgress.",
    inputSchema: {
      type: "object",
      properties: {
        Value: {
          type: "number",
          description: "The new target value.",
        },
      },
      required: ["Value"],
    },
  },
  {
    name: "start_trigger_check",
    description:
      "Start Trigger Check. Enables the periodic Adaptive Planning monitor that checks child accounts of Detect_and_Alert_Triggers and writes non-zero account names to the Trigger range.",
    inputSchema: {
      type: "object",
      properties: {
        Seconds: {
          type: "number",
          description:
            "Optional interval in seconds between checks. Uses the current interval when omitted.",
        },
      },
    },
  },
  {
    name: "stop_trigger_check",
    description:
      "Stop Trigger Check. Disables the periodic Adaptive Planning monitor.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "set_check_interval",
    description:
      "Set Check Interval. Adjusts how many seconds elapse between each Adaptive Planning trigger check.",
    inputSchema: {
      type: "object",
      properties: {
        Seconds: {
          type: "number",
          description: "The number of seconds between each trigger check.",
        },
      },
      required: ["Seconds"],
    },
  },
];

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function readTargetValue(args) {
  const value = args?.Value ?? args?.value;
  if (value === undefined || value === null || value === "") {
    throw new Error("Value is required and must be a number.");
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw new Error("Value must be a valid number.");
  }

  return numericValue;
}

function readSeconds(args, { required = true } = {}) {
  const value = args?.Seconds ?? args?.seconds;
  if (value === undefined || value === null || value === "") {
    if (!required) {
      return undefined;
    }
    throw new Error("Seconds is required and must be a positive number.");
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error("Seconds must be a positive number.");
  }

  return numericValue;
}

async function handleToolCall(name, args = {}) {
  if (name === "get_alert_message") {
    const trigger = await getTrigger();
    const triggerValue = trigger.value;

    if (triggerValue === null || triggerValue === undefined || triggerValue === "") {
      throw new Error("Trigger named range is empty.");
    }

    await setInProgress(1);
    const message = await buildAlertMessage(String(triggerValue));
    return textResult(message);
  }

  if (name === "update_target") {
    const value = readTargetValue(args);
    const ids = await resolveTargetWriteIds();
    const planningResult = await writeExpenseTarget(value, ids);
    const result = await updateTarget(value);

    return textResult(
      `Target updated to ${value} in Adaptive Planning and Google Sheet. Cleared Trigger and InProgress.\n${JSON.stringify({ planning: planningResult, sheet: result.result })}`,
    );
  }

  if (name === "start_trigger_check") {
    const seconds = readSeconds(args, { required: false });
    const status = startTriggerMonitor(
      seconds === undefined ? {} : { intervalSeconds: seconds },
    );

    return textResult(
      `Trigger check started. Interval: ${status.intervalSeconds} second(s).\n${JSON.stringify(status)}`,
    );
  }

  if (name === "stop_trigger_check") {
    const status = stopTriggerMonitor();
    return textResult(`Trigger check stopped.\n${JSON.stringify(status)}`);
  }

  if (name === "set_check_interval") {
    const seconds = readSeconds(args);
    const status = setTriggerCheckInterval(seconds);
    return textResult(
      `Trigger check interval set to ${status.intervalSeconds} second(s).\n${JSON.stringify(status)}`,
    );
  }

  return {
    ...textResult(`Unknown tool: ${name}`),
    isError: true,
  };
}

export async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
        instructions:
          "Detect & Alert monitors planning conditions. Use get_alert_message when an expense-plan alert should be raised; it reads Trigger from the Google Sheet and current plan/target values from Adaptive Planning. Use update_target to prorate a new annual target across monthly Expense_Target values in Adaptive Planning and clear Trigger and InProgress in the Google Sheet. Use start_trigger_check, stop_trigger_check, and set_check_interval to control the periodic Adaptive Planning monitor.",
      },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};
    try {
      const result = await handleToolCall(toolName, toolArgs);
      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        },
      };
    }
  }

  if (id !== undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return null;
}

export function isJsonRpcRequest(message) {
  return (
    message &&
    typeof message === "object" &&
    message.jsonrpc === "2.0" &&
    typeof message.method === "string" &&
    message.id !== undefined
  );
}

export function isJsonRpcNotification(message) {
  return (
    message &&
    typeof message === "object" &&
    message.jsonrpc === "2.0" &&
    typeof message.method === "string" &&
    message.id === undefined
  );
}

export { getTriggerMonitorStatus, runTriggerCheck };
