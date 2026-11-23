// @vitest-environment node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, it, vi } from 'vitest';
import { startMcpServer, stopMcpServer } from '../src/main/mcp/server';

const fake = vi.hoisted(() => ({ services: null as object | null, serve: vi.fn() }));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => fake }));
vi.mock('../src/main/media_protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/media_protocol')>()),
  handleMediaRequest: fake.serve,
}));

afterEach(async () => {
  fake.services = null;
  await stopMcpServer();
});

it('issues private and group video downloads only for the exact message and bound account', async () => {
  const video = (label: string) => ({
    type: 'video',
    data: { fileName: `${label}.mp4`, fileToken: `${label}-fixture-key`, fileSize: 4 },
  });
  const group = {
    targetGroupCode: '12345',
    sendTime: 123n,
    elements: [video('one'), { type: 'text' }, video('two')],
  };
  const direct = { targetUid: 'u_fixture', sendTime: 456n, elements: [video('direct')] };
  fake.services = {
    msgs: {
      // The raw lookups are by ID and can return a row from another conversation.
      getGroupMessageById: async () => group,
      getC2cMessageById: async () => direct,
    },
  };
  const port = await startMcpServer({ port: 0, token: 'synthetic-only' });
  const base = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'chat-video-fixture', version: '1' });
  const headers = { Authorization: 'Bearer synthetic-only' };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers } }),
  );
  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: 'download_chat_video', arguments: { msgId: '1001', ...args } });
  const downloadPath = async (target: Record<string, unknown>, fileName: string) => {
    const result = await call(target);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      fileName,
      downloadPath: expect.stringMatching(/^\/chat\/videos\//),
      expiresIn: 300,
      size: 4,
    });
    return new URL(String(result.structuredContent?.downloadPath), base);
  };
  try {
    expect((await call({ kind: 'group', conv: '12346' })).isError).toBe(true);
    expect((await call({ kind: 'c2c', conv: 'u_other' })).isError).toBe(true);
    expect((await call({ kind: 'group', conv: '12345', videoIndex: 2 })).isError).toBe(true);
    const groupUrl = await downloadPath({ kind: 'group', conv: '12345', videoIndex: 1 }, 'two.mp4');
    const directUrl = await downloadPath({ kind: 'c2c', conv: 'u_fixture' }, 'direct.mp4');
    expect((await fetch(groupUrl)).status).toBe(401);
    expect(fake.serve).not.toHaveBeenCalled();

    const bytes = Uint8Array.of(0, 1, 2, 255);
    fake.serve.mockResolvedValueOnce(
      new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }),
    );
    const response = await fetch(groupUrl, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('two.mp4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const request = fake.serve.mock.calls[0]?.[0] as Request;
    const query = new URL(request.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      t: '123000',
      name: 'two.mp4',
      token: 'two-fixture-key',
      msgId: '1001',
      conv: '12345',
      intent: 'interactive',
    });

    fake.serve.mockResolvedValueOnce(new Response('upstream fixture', { status: 404 }));
    const unavailable = await fetch(directUrl, { headers });
    expect(unavailable.status).toBe(422);
    expect(await unavailable.text()).not.toContain('upstream fixture');
    expect(new URL(fake.serve.mock.calls[1]?.[0].url).searchParams.get('conv')).toBe('');
    fake.services = { ...fake.services };
    expect((await fetch(groupUrl, { headers })).status).toBe(404);
    expect(fake.serve).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
  }
});
