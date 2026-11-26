// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, stopMcpServer } from '../src/main/mcp/server';

const fake = vi.hoisted(() => ({ services: null as object | null }));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => fake }));

afterEach(async () => {
  fake.services = null;
  await stopMcpServer();
});

it('reads without marking, projects only requested HTTPS links, and downloads only with the MCP bearer', async () => {
  const id = randomUUID();
  const summary = {
    id: 'm-fixture',
    folderId: 1,
    subject: '设备导出',
    sender: { email: 'service@example.test', name: 'Service' },
    time: 123,
    unread: true,
    hasAttachments: true,
    to: [],
  };
  const preview = vi.fn(async () => ({
    ...summary,
    bodyAvailable: true,
    html:
      '<p>数据副本已就绪</p><script>hidden</script><img src="https://files.example.test/pixel">' +
      '<a href="https://files.example.test/download?a=1&amp;b=2">数据包</a>' +
      '<a href="https://other.example.test/other">外链</a>' +
      '<a href="https://files.example.test.other.example.test/no">假域名</a>' +
      '<a href="http://files.example.test/no">非 HTTPS</a>' +
      '<a hidden href="https://files.example.test/hidden">隐藏链接</a>',
    attachments: [
      { id, name: '../数据.zip', size: 3, available: true, sourceKey: 'not-for-clients' },
    ],
  }));
  const list = vi.fn(async () => ({ items: [summary], page: 0, hasMore: false }));
  const get = vi.fn((value: string) => {
    if (value !== id) throw new Error('unknown attachment');
    return { name: '../数据.zip', size: 3 };
  });
  const download = vi.fn(
    async (_id: string, path: string, _signal: AbortSignal, _limit: number) => {
      await writeFile(path, 'zip');
    },
  );
  fake.services = { mail: { preview, list, attachments: { get }, download } };
  const token = 'mcp-fixture-token';
  const port = await startMcpServer({ port: 0, token });
  const base = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'mail-mcp-test', version: '1.0.0' });
  const headers = { Authorization: `Bearer ${token}` };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers } }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    const first = (result.content as Array<{ text: string }>)[0];
    return JSON.parse(first?.text ?? 'null');
  };
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'list_mail_folders',
        'list_mail_messages',
        'get_mail_message',
        'download_mail_attachment',
      ]),
    );
    expect((await call('list_mail_messages', { keyword: '设备导出', limit: 1 })).items[0].id).toBe(
      summary.id,
    );
    expect(list).toHaveBeenCalledWith(
      { keyword: '设备导出', folderId: 1, page: 0, pageSize: 1 },
      expect.any(AbortSignal),
    );
    const body = await call('get_mail_message', {
      id: summary.id,
      linkHosts: ['files.example.test'],
    });
    expect(preview).toHaveBeenLastCalledWith(summary.id, expect.any(AbortSignal));
    expect(body.bodyAvailable).toBe(true);
    expect(body.text).toContain('数据副本已就绪');
    expect(body.text).not.toContain('hidden');
    expect(body.links).toEqual(['https://files.example.test/download?a=1&b=2']);
    expect(body.attachments[0]).not.toHaveProperty('sourceKey');
    const { downloadPath } = await call('download_mail_attachment', { id });
    expect((await fetch(new URL(downloadPath, base))).status).toBe(401);
    expect(download).not.toHaveBeenCalled();
    const response = await fetch(new URL(downloadPath, base), { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('%E6%95%B0%E6%8D%AE.zip');
    expect(await response.text()).toBe('zip');
    expect(download).toHaveBeenCalledWith(id, expect.any(String), expect.any(AbortSignal), 3);
  } finally {
    await client.close();
  }
});
