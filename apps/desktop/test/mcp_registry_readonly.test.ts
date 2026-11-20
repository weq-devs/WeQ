// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, stopMcpServer } from '../src/main/mcp/server';

vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ services: {}, account: { msgDbPath: '/synthetic/mcp-performance.db' } }),
}));

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
    expect(names).toContain('get_message_performance');
    expect(names).toContain('list_settings');
    expect(names).toContain('list_features');
    expect(names).toContain('get_feature');
    const featureCall = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    const first = await featureCall('list_features', { domain: 'export', limit: 1 });
    expect(first.entries).toHaveLength(1);
    const next = await featureCall('list_features', {
      domain: 'export',
      limit: 1,
      offset: first.nextOffset,
    });
    expect(next.entries[0].id).not.toBe(first.entries[0].id);
    const group = await featureCall('get_feature', { id: 'groups.albums', client: 'remote' });
    expect(group.entry).toEqual({ status: 'needs-context', missing: ['group'] });
    expect(group.tools).toEqual([{ name: 'get_group_albums', exposed: true }]);
    expect(group.navigation).not.toHaveProperty('url');
    expect(
      (await featureCall('get_feature', { id: 'maintenance.message-performance' })).navigation,
    ).toBeNull();
    const desktopSetting = await featureCall('get_feature', {
      id: 'setting:startup-enabled',
      client: 'remote',
    });
    expect(desktopSetting.entry.status).toBe('unsupported');
    expect((await featureCall('get_feature', { id: 'unknown.fixture' })).found).toBe(false);
    const settings = await client.callTool({
      name: 'list_settings',
      arguments: { page: 'appearance', query: '深色' },
    });
    expect(settings.isError).not.toBe(true);
    const definitions = JSON.parse((settings.content as Array<{ text: string }>)[0]!.text);
    expect(definitions.map((item: { id: string }) => item.id)).toEqual(['theme-mode']);
    expect(definitions[0].reset[0].defaultSource).toBe('client:preference');
    expect(definitions[0]).not.toHaveProperty('current');
    const snapshot = await client.callTool({ name: 'get_message_performance', arguments: {} });
    expect(snapshot.isError).not.toBe(true);
    const text = (snapshot.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(JSON.parse(text).database.jsQueueWait.count).toBe(0);
    expect(text).not.toContain('/synthetic/mcp-performance.db');
    // 账号切换是显式审核过要暴露给外部客户端的（见 tool_permissions.ts 的说明），
    // 别被误标成 assistantOnly 而在界面上消失。
    expect(names).toContain('list_accounts');
    expect(names).toContain('switch_account');
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
