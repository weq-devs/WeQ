// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, stopMcpServer } from '../src/main/mcp/server';

vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => ({}) }));

it('lists the real registry without exposing SQL writes, messaging, wallet, credentials or host files', async () => {
  const port = await startMcpServer({ port: 39873, token: 'synthetic-only' });
  const client = new Client({ name: 'synthetic-registry', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer synthetic-only' } },
      }),
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('search_messages');
    expect(names).toContain('get_messages');
    for (const name of [
      'execute_sql',
      'decode_db_blob',
      'query_sqlite_file',
      'decrypt_database',
      'send_text_message',
      'send_media_message',
      'send_rich_message',
      'send_file_message',
      'send_forward_message',
      'send_tuwen_ark',
      'send_poke',
      'set_message_reaction',
      'send_group_signup',
      'pack_red_bag',
      'grab_red_bag',
      'get_web_tokens',
      'get_client_key',
      'get_download_rkeys',
      'run_js',
      'export_conversation',
      'set_anti_recall',
    ])
      expect(names).not.toContain(name);
  } finally {
    await client.close();
    await stopMcpServer();
  }
});
