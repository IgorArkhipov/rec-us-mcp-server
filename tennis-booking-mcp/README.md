# Building a Remote MCP Server on Cloudflare (Without Auth)

This example allows you to deploy a remote MCP server that doesn't require authentication on Cloudflare Workers.

## Get started:

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your MCP server to a URL like: `remote-mcp-server-authless.<your-account>.workers.dev/sse`

Alternatively, you can use the command line below to get the remote MCP Server created on your local machine:

```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

## Customizing your MCP Server

To add your own [tools](https://developers.cloudflare.com/agents/model-context-protocol/tools/) to the MCP server, define each tool inside the `init()` method of `src/index.ts` using `this.server.tool(...)`.

## Connect to Cloudflare AI Playground

You can connect to your MCP server from the Cloudflare AI Playground, which is a remote MCP client:

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed MCP server URL (`remote-mcp-server-authless.<your-account>.workers.dev/sse`)
3. You can now use your MCP tools directly from the playground!

## Connect Claude Desktop to your MCP server

You can also connect to your remote MCP server from local MCP clients, by using the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote).

To connect to your MCP server from Claude Desktop, follow [Anthropic's Quickstart](https://modelcontextprotocol.io/quickstart/user) and within Claude Desktop go to Settings > Developer > Edit Config.

Update with this configuration:

```json
{
	"mcpServers": {
		"calculator": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"http://localhost:8787/sse" // or remote-mcp-server-authless.your-account.workers.dev/sse
			]
		}
	}
}
```

Restart Claude and you should see the tools become available.

## Local Browser Fallback (No Cloudflare Browser Limits)

When Cloudflare Browser Rendering is rate-limited (429), you can run a local MCP server that uses your machine's Playwright browser instead of `env.MYBROWSER`.

1. Install Chromium for Playwright once:

```bash
npx playwright install chromium
```

2. Start the local-browser MCP server:

```bash
npm run dev:local-browser --port 8788
```

For visible browser windows (headed mode), use:

```bash
npm run dev:local-browser:headed --port 8788
```

This server runs over stdio (for local MCP clients) and supports the same core tools:

- `check_tennis_courts`
- `book_and_request_sms`
- `check_checkout_status`
- `continue_checkout_to_sms`
- `enter_sms_code_and_complete`
- `test_browser`
- `get_booking_history`
- `auth_status`
- `get_auth_url`

It reads credentials from environment variables or `.dev.vars`:

- `REC_EMAIL`
- `REC_PASSWORD`

When tool steps fail, screenshots are saved to:

- `artifacts/screenshots/`

Optional runtime flags:

- `LOCAL_BROWSER_HEADLESS=false` (show browser UI)
- `LOCAL_BROWSER_CAPTURE_SCREENSHOTS=false` (disable screenshots)
- `LOCAL_BROWSER_SUBCOURTS="Court 1,Court 2"` (subcourt preference order for bookings)

## Scheduled Sunday Auto-Book Script

Run:

```bash
npm run auto-book:sunday
```

What it does by default:

- waits until `07:00` local time if started earlier;
- targets the closest Sunday date;
- checks your configured court (default: `Potrero Hill`);
- looks for the earliest available slot between `07:30 AM` and `12:00 PM`;
- retries every 60 seconds until success or max attempts;
- reaches SMS verification, then prompts you to enter the SMS code to finish booking.

Useful environment variables:

- `AUTO_BOOK_COURT` (default `Potrero Hill`)
- `AUTO_BOOK_SUBCOURTS` (default `Court 1,Court 2`)
- `AUTO_BOOK_POLL_MS` (default `60000`)
- `AUTO_BOOK_MAX_ATTEMPTS` (default `90`)
- `AUTO_BOOK_HEADED=false` to run headless
- `AUTO_BOOK_SKIP_WAIT=true` to run immediately (skip waiting until 07:00)

### Claude Desktop config for local-browser fallback

```json
{
	"mcpServers": {
		"tennis-booking-local-browser": {
			"command": "npm",
			"args": ["run", "dev:local-browser"],
			"cwd": "/Users/igor.arkhipov/Documents/Work/rec-us-mcp-server/tennis-booking-mcp"
		}
	}
}
```
