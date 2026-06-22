/**
 * Tool registry for the SendByte MCP server.
 *
 * Each tool maps onto a documented SendByte REST endpoint. Inputs are described
 * for the model with `.describe(...)`; results are returned as pretty-printed
 * JSON text. API errors are surfaced as `isError` tool results (with the error
 * code, message, and docs link) rather than thrown, so the agent can recover.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SendByteClient, SendByteError } from './client.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  let text: string;
  if (err instanceof SendByteError) {
    text = `Error [${err.code}]: ${err.message}${err.docsUrl ? `\nDocs: ${err.docsUrl}` : ''}`;
  } else {
    text = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { content: [{ type: 'text', text }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const EMAIL_STATUS = z.enum([
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'suppressed',
]);

const addressList = z.union([z.string(), z.array(z.string())]);

export function registerTools(server: McpServer, client: SendByteClient): void {
  /* ------------------------------- Emails ------------------------------- */

  server.tool(
    'send_email',
    'Send a transactional email through SendByte. The sender domain must be a verified sending domain (or use the shared test domain with a test key). Provide html and/or text, or a template_id with variables. A test key (sk_test_) sandboxes the send.',
    {
      from: z
        .string()
        .describe('Sender, e.g. "PayLink <receipts@paylink.ng>". Domain must be verified.'),
      to: addressList.describe('Recipient address or array of addresses.'),
      subject: z.string().describe('Email subject line.'),
      html: z.string().optional().describe('HTML body. Provide html and/or text, or use template_id.'),
      text: z.string().optional().describe('Plain-text body. Recommended alongside html.'),
      cc: addressList.optional(),
      bcc: addressList.optional(),
      reply_to: addressList.optional().describe('Reply-To address or addresses.'),
      tags: z.array(z.string()).optional().describe('Free-form tags for filtering and analytics.'),
      template_id: z
        .string()
        .optional()
        .describe('Send a saved template instead of inline html/text.'),
      variables: z
        .record(z.unknown())
        .optional()
        .describe('Handlebars variables to render into the template.'),
      scheduled_at: z.string().optional().describe('ISO 8601 timestamp to send later.'),
    },
    async (args) => {
      if (!args.html && !args.text && !args.template_id) {
        return fail(
          new SendByteError(
            'validation_error',
            'Provide html, text, or a template_id to send.',
            0
          )
        );
      }
      return run(() => client.request('POST', '/v1/emails', args));
    }
  );

  server.tool(
    'get_email',
    'Fetch one email by id, including its delivery status and event timeline (queued, sent, delivered, bounced, complained).',
    { id: z.string().describe('The email id returned by send_email.') },
    async ({ id }) => run(() => client.request('GET', `/v1/emails/${encodeURIComponent(id)}`))
  );

  server.tool(
    'list_emails',
    'List recent emails for the project, newest first, with cursor pagination. Optionally filter by delivery status.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (1-100).'),
      after: z.string().optional().describe('Email id to page after (cursor).'),
      status: EMAIL_STATUS.optional().describe('Filter by delivery status.'),
    },
    async ({ limit, after, status }) =>
      run(() =>
        client.request('GET', `/v1/emails${SendByteClient.query({ limit, after, status })}`)
      )
  );

  /* ------------------------------ Domains ------------------------------- */

  server.tool(
    'list_domains',
    'List the sending domains on the account with their verification status and whether deliverability (SPF/DMARC/MAIL FROM) is fully configured.',
    {},
    async () => run(() => client.request('GET', '/v1/domains'))
  );

  server.tool(
    'get_domain',
    'Get one sending domain by id, including the DNS records to publish (DKIM, SPF, DMARC, MAIL FROM) and their current state.',
    { id: z.string().describe('The domain id.') },
    async ({ id }) => run(() => client.request('GET', `/v1/domains/${encodeURIComponent(id)}`))
  );

  server.tool(
    'verify_domain',
    'Re-check a domain\'s DNS records and SES status now, and report which records pass and whether the domain is verified.',
    { id: z.string().describe('The domain id to re-verify.') },
    async ({ id }) =>
      run(() => client.request('POST', `/v1/domains/${encodeURIComponent(id)}/verify`))
  );

  /* ----------------------------- Templates ------------------------------ */

  server.tool(
    'list_templates',
    'List saved email templates for the project (id, name, subject, format, version).',
    {},
    async () => run(() => client.request('GET', '/v1/templates'))
  );

  server.tool(
    'get_template',
    'Get one saved template by id, including its subject and body (html/text/mjml).',
    { id: z.string().describe('The template id.') },
    async ({ id }) => run(() => client.request('GET', `/v1/templates/${encodeURIComponent(id)}`))
  );

  server.tool(
    'preview_template',
    'Render a saved template with sample variables and return the resolved subject and body, without sending anything.',
    {
      id: z.string().describe('The template id to render.'),
      variables: z
        .record(z.unknown())
        .optional()
        .describe('Handlebars variables to substitute. Missing variables render empty.'),
    },
    async ({ id, variables }) =>
      run(() =>
        client.request('POST', `/v1/templates/${encodeURIComponent(id)}/preview`, {
          variables: variables ?? {},
        })
      )
  );

  /* ----------------------------- Analytics ------------------------------ */

  server.tool(
    'get_analytics',
    'Get daily send counts by status and deliverability rates (delivered, bounce, complaint) over the last N days.',
    {
      days: z.number().int().min(1).max(90).optional().describe('Window size in days (1-90, default 30).'),
    },
    async ({ days }) =>
      run(() => client.request('GET', `/v1/analytics${SendByteClient.query({ days })}`))
  );

  /* --------------------------- Content scan ----------------------------- */

  server.tool(
    'scan_content',
    'Pre-send deliverability and spam-risk check for email content. Returns a score, risk level, and the specific signals found, so an agent can fix risky content before sending.',
    {
      subject: z.string().optional().describe('Subject line to scan.'),
      html: z.string().optional().describe('HTML body to scan.'),
      text: z.string().optional().describe('Plain-text body to scan.'),
      from: z
        .string()
        .optional()
        .describe('Optional From, e.g. "PayLink <hi@paylink.ng>", to flag display-name vs domain mismatches.'),
    },
    async (args) => {
      if (!args.subject && !args.html && !args.text) {
        return fail(
          new SendByteError('validation_error', 'Provide subject, html, and/or text to scan.', 0)
        );
      }
      return run(() => client.request('POST', '/v1/content/scan', args));
    }
  );
}
