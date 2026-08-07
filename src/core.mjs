import { setInProgress, updateTarget } from "./google-sheets.mjs";

export const SERVER_INFO = { name: "Detect & Alert", version: "1.1.0" };
export const PROTOCOL_VERSION = "2024-11-05";

const ALERT_MESSAGE = `Alert condition triggered - Expense Plan Exceeds Target
The current target is 46.400,000. Would you like to adjust the target?`;

const TOOLS = [
  {
    name: "get_alert_message",
    description:
      "Get Alert Message. Sets the Google Sheet InProgress range to 1 and returns the expense-plan alert text.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_target",
    description:
      "Update Target. Accepts a new target value, then clears the Trigger and InProgress named ranges in the Google Sheet.",
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

async function handleToolCall(name, args = {}) {
  if (name === "get_alert_message") {
    await setInProgress(1);
    return textResult(ALERT_MESSAGE);
  }

  if (name === "update_target") {
    const value = readTargetValue(args);
    const result = await updateTarget(value);

    return textResult(
      `Target updated to ${value}. Cleared Trigger and InProgress.\n${JSON.stringify(result.result)}`,
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
          "Detect & Alert monitors planning conditions. Use get_alert_message when an expense-plan alert should be raised. Use update_target to set a new target value and clear Trigger and InProgress.",
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
