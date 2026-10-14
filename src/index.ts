/**
 * SendByte MCP server (stdio transport).
 *
 * Exposes SendByte's email API as MCP tools so AI agents and coding tools
 * (Claude Desktop, Claude Code, Cursor, Continue, ...) can send email and
 * manage sending domains, templates, analytics, and content checks through
 * the user's own SendByte API key.
 *
 * Configuration (environment):
 *   SENDBYTE_API_KEY   required. An sk_live_ or sk_test_ key from the dashboard.
 *   SENDBYTE_BASE_URL  optional. Override the API host (self-hosted/staging/dev).
 *
 * stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SendByteClient, SendByteError } from './client.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const apiKey = process.env.SENDBYTE_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      'sendbyte-mcp: SENDBYTE_API_KEY is not set. Create a key in the SendByte dashboard ' +
        '(API keys) and set SENDBYTE_API_KEY in your MCP server config.\n'
    );
    process.exit(1);
  }

  const baseUrl = process.env.SENDBYTE_BASE_URL;
  let client: SendByteClient;
  try {
    client = new SendByteClient(apiKey, baseUrl ? { baseUrl } : {});
  } catch (err) {
    const message = err instanceof SendByteError ? err.message : String(err);
    process.stderr.write(`sendbyte-mcp: ${message}\n`);
    process.exit(1);
    return;
  }

  const server = new McpServer({ name: 'sendbyte', version: '0.2.0' });
  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('sendbyte-mcp: ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`sendbyte-mcp: fatal ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
