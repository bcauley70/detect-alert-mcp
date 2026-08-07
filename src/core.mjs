import { setInProgress } from "./google-sheets.mjs";

export const SERVER_INFO = { name: "Detect & Alert", version: "1.0.0" };
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
];

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

async function handleToolCall(name) {
  if (name === "get_alert_message") {
    await setInProgress(1);
    return textResult(ALERT_MESSAGE);
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
          "Detect & Alert monitors planning conditions. Use get_alert_message when an expense-plan alert should be raised.",
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
    try {
      const result = await handleToolCall(toolName);
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
