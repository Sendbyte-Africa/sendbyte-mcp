import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SendByteClient, SendByteError } from '../src/client.js';
import { registerTools } from '../src/tools.js';

const KEY = 'sk_test_' + 'a'.repeat(40);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('SendByteClient', () => {
  it('rejects keys without an sk_ prefix', () => {
    expect(() => new SendByteClient('nope')).toThrow(SendByteError);
  });

  it('refuses a live key over an insecure base url', () => {
    expect(
      () => new SendByteClient('sk_live_' + 'b'.repeat(40), { baseUrl: 'http://example.com' })
    ).toThrow(/insecure/i);
  });

  it('sends the bearer auth header and parses JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
      return jsonResponse({ id: 'em_1', status: 'queued' });
    });
    const client = new SendByteClient(KEY, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.request('GET', '/v1/emails/em_1');
    expect(res).toEqual({ id: 'em_1', status: 'queued' });
  });

  it('auto-injects an idempotency_key on POST /v1/emails', async () => {
    let captured: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return jsonResponse({ id: 'em_2' }, 201);
    });
    const client = new SendByteClient(KEY, { fetch: fetchMock as unknown as typeof fetch });
    await client.request('POST', '/v1/emails', { from: 'a@b.co', to: 'c@d.co', subject: 'x', text: 'y' });
    expect(typeof captured.idempotency_key).toBe('string');
    expect((captured.idempotency_key as string).length).toBeGreaterThan(10);
  });

  it('retries a 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'rate_limited' } }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new SendByteClient(KEY, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.request('GET', '/v1/domains');
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps an error body into a typed SendByteError', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'not_found', message: 'no such email', docs_url: 'https://d' } }, 404)
    );
    const client = new SendByteClient(KEY, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.request('GET', '/v1/emails/x')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      docsUrl: 'https://d',
    });
  });

  it('builds query strings, skipping undefined', () => {
    expect(SendByteClient.query({ limit: 10, after: undefined, status: 'sent' })).toBe(
      '?limit=10&status=sent'
    );
    expect(SendByteClient.query({ a: undefined })).toBe('');
  });
});

async function connectedClient(fetchMock: typeof fetch): Promise<Client> {
  const sbClient = new SendByteClient(KEY, { fetch: fetchMock });
  const server = new McpServer({ name: 'sendbyte', version: 'test' });
  registerTools(server, sbClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP server wiring', () => {
  it('exposes the full tool surface', async () => {
    const client = await connectedClient((async () => jsonResponse({})) as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'get_analytics',
        'get_domain',
        'get_email',
        'get_template',
        'list_domains',
        'list_emails',
        'list_templates',
        'preview_template',
        'scan_content',
        'send_email',
        'verify_domain',
      ].sort()
    );
  });

  it('send_email forwards to the API and returns the result', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'em_9', status: 'queued' }, 201));
    const client = await connectedClient(fetchMock as unknown as typeof fetch);
    const res = await client.callTool({
      name: 'send_email',
      arguments: { from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Body' },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text)).toEqual({ id: 'em_9', status: 'queued' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('send_email rejects a body with no html/text/template_id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = await connectedClient(fetchMock as unknown as typeof fetch);
    const res = await client.callTool({
      name: 'send_email',
      arguments: { from: 'a@b.co', to: 'c@d.co', subject: 'Hi' },
    });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
