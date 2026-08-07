# Deploy Detect & Alert MCP Publicly

## GitHub repository

https://github.com/bcauley70/detect-alert-mcp

## Recommended: Render (permanent, like MCP1)

1. Open https://dashboard.render.com
2. Click **New +** → **Blueprint**
3. Connect the `bcauley70/detect-alert-mcp` repository
4. Branch: `master`
5. Click **Deploy Blueprint**

Render reads `render.yaml` and creates a web service named `detect-alert-mcp`.

After deploy, your public MCP endpoint will be:

```text
https://detect-alert-mcp.onrender.com/mcp
```

### Get the generated API key

1. Open the `detect-alert-mcp` service in Render
2. Go to **Environment**
3. Copy the generated `MCP_API_KEY` value

### Connect Cursor to the public server

Add to `~/.cursor/mcp.json`:

```json
"Detect & Alert (public)": {
  "url": "https://detect-alert-mcp.onrender.com/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_RENDER_MCP_API_KEY"
  }
}
```

### Test the public endpoint

```powershell
$env:MCP_API_KEY="YOUR_RENDER_MCP_API_KEY"
node scripts/test-remote-mcp.mjs https://detect-alert-mcp.onrender.com/mcp $env:MCP_API_KEY
```

## Local HTTP (for development)

```powershell
$env:MCP_TRANSPORT="http"
$env:HOST="0.0.0.0"
$env:PORT="3001"
$env:MCP_API_KEY="detect-alert-demo-2026"
node src/index.mjs
```

Health check:

```text
http://127.0.0.1:3001/health
```

MCP endpoint:

```text
http://127.0.0.1:3001/mcp
```

## Docker

```bash
docker compose up --build
```

Public port mapping: `3001 -> 3000`

## Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/health` | GET | Health check |
| `/mcp` | POST | MCP streamable HTTP endpoint |
| `/` | GET | Server info |

## Security

Public deployments should always set `MCP_API_KEY`. Requests must include:

```text
Authorization: Bearer <MCP_API_KEY>
```

or

```text
X-API-Key: <MCP_API_KEY>
```
