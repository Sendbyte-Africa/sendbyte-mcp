# @sendbyte/mcp

The official [SendByte](https://sendbyte.africa) MCP server. It lets AI agents and coding tools (Claude Desktop, Claude Code, Cursor, Continue, and any [Model Context Protocol](https://modelcontextprotocol.io) client) send email and manage sending domains, templates, analytics, and content checks through your SendByte account.

It speaks MCP over stdio and authenticates with your own SendByte API key.

## Quick start

You need a SendByte API key. Create one in the dashboard under **API keys** (use a `sk_test_` key while you experiment; it sandboxes every send).

No global install is needed. Point your MCP client at `npx @sendbyte/mcp` and set `SENDBYTE_API_KEY` in its environment.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "sendbyte": {
      "command": "npx",
      "args": ["-y", "@sendbyte/mcp"],
      "env": { "SENDBYTE_API_KEY": "sk_test_your_key_here" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add sendbyte --env SENDBYTE_API_KEY=sk_test_your_key_here -- npx -y @sendbyte/mcp
```

### Cursor

Add to `~/.cursor/mcp.json` (or a project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sendbyte": {
      "command": "npx",
      "args": ["-y", "@sendbyte/mcp"],
      "env": { "SENDBYTE_API_KEY": "sk_test_your_key_here" }
    }
  }
}
```

### Continue

In `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@sendbyte/mcp"],
          "env": { "SENDBYTE_API_KEY": "sk_test_your_key_here" }
        }
      }
    ]
  }
}
```

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `SENDBYTE_API_KEY` | yes | An `sk_live_` or `sk_test_` key from the dashboard. A test key sandboxes every send. |
| `SENDBYTE_BASE_URL` | no | Override the API host for self-hosted, staging, or local development. Defaults to `https://api.sendbyte.africa`. |

## Tools

| Tool | What it does |
| --- | --- |
| `send_email` | Send a transactional email (inline html/text, or a saved template with variables). |
| `get_email` | Fetch one email by id with its delivery status and event timeline. |
| `list_emails` | List recent emails, newest first, with optional status filter and cursor paging. |
| `list_domains` | List sending domains with verification and deliverability state. |
| `get_domain` | Get one domain with the DNS records to publish and their current state. |
| `verify_domain` | Re-check a domain's DNS and SES status now. |
| `list_templates` | List saved templates. |
| `get_template` | Get one template's subject and body. |
| `preview_template` | Render a saved template with sample variables, without sending. |
| `get_analytics` | Daily send counts by status and deliverability rates over the last N days. |
| `scan_content` | Pre-send spam-risk check returning a score, level, and the signals found. |

## Notes

- A `sk_test_` key sandboxes sends, so an agent can exercise `send_email` safely. Switch to `sk_live_` only when you want real delivery.
- The sender domain on `send_email` must be a verified sending domain on your account (or the shared test domain when using a test key).
- The server writes only to stderr; stdout is reserved for the MCP protocol.

## License

MIT
