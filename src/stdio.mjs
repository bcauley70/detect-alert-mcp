import { handleRequest } from "./core.mjs";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

export async function startStdioServer() {
  let buffer = "";
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const response = await handleRequest(message);
      if (response) send(response);
    }
  });

  process.stderr.write("Detect & Alert MCP server running on stdio\n");
}
