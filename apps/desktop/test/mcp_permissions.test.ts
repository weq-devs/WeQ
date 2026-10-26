// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { aiToolSpecs, assistantToolSpecs, runAssistantTool } from '../src/main/mcp/openai_tools';
import { startMcpServer, stopMcpServer } from '../src/main/mcp/server';
import { bindAccountTools } from '../src/main/mcp/account_scope';

const f = vi.hoisted(() => ({
  mode: 'sandbox',
  execute: vi.fn(async () => 'synthetic'),
  external: vi.fn(async () => 'external'),
  specs: vi.fn(async () => []),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: { assistant: { getConfig: () => ({ permissionMode: f.mode }) } },
  }),
}));
vi.mock('../src/main/mcp/external', () => ({
  getExternalMcpHub: () => ({ run: f.external, specs: f.specs }),
}));
vi.mock('../src/main/mcp/tools', () => ({
  AI_TOOLS: [
    'search_messages',
    'execute_sql',
    'decrypt_database',
    'send_text_message',
    'pack_red_bag',
    'grab_red_bag',
    'run_js',
    'get_web_tokens',
    'new_unknown_tool',
  ].map((name) => ({ name, description: name, input: z.object({}), run: f.execute })),
}));

beforeEach(() => {
  f.mode = 'sandbox';
  vi.clearAllMocks();
});
afterEach(async () => {
  await stopMcpServer();
});

it('defaults to reviewed sandbox tools and rejects hallucinated/hidden tool calls at execution', async () => {
  expect(aiToolSpecs().map((tool) => tool.function.name)).toEqual(['search_messages', 'run_js']);
  for (const name of [
    'execute_sql',
    'decrypt_database',
    'send_text_message',
    'get_web_tokens',
    'mcp__remote__write',
    'new_unknown_tool',
  ]) {
    await expect(runAssistantTool(name, {})).rejects.toThrow('沙箱模式');
  }
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.external).not.toHaveBeenCalled();
  await assistantToolSpecs({ permissionMode: 'sandbox' });
  expect(f.specs).not.toHaveBeenCalled();
  expect(await runAssistantTool('search_messages', {})).toBe('synthetic');
});

it('requires both the run snapshot and the current setting for unrestricted calls', async () => {
  f.mode = 'unrestricted';
  await expect(runAssistantTool('execute_sql', {})).rejects.toThrow('沙箱模式');
  expect(await runAssistantTool('execute_sql', {}, { permissionMode: 'unrestricted' })).toBe(
    'synthetic',
  );
  expect(await runAssistantTool('mcp__remote__write', {}, { permissionMode: 'unrestricted' })).toBe(
    'external',
  );
  f.mode = 'sandbox';
  await expect(
    runAssistantTool('execute_sql', {}, { permissionMode: 'unrestricted' }),
  ).rejects.toThrow('沙箱模式');
});

it('nested calls inherit the permission snapshot and cancellation signal', async () => {
  f.mode = 'unrestricted';
  const account = {};
  const controller = new AbortController();
  const run = bindAccountTools(
    account,
    () => account,
    async () => runAssistantTool('execute_sql', {}),
  );
  expect(
    await run('run_js', {}, { permissionMode: 'unrestricted', signal: controller.signal }),
  ).toBe('synthetic');
  controller.abort();
  await expect(
    run('run_js', {}, { permissionMode: 'unrestricted', signal: controller.signal }),
  ).rejects.toThrow();
  expect(f.execute).toHaveBeenCalledOnce();
});

it('actual external tools/list and tools/call never expose write, credential, or unknown tools', async () => {
  f.mode = 'unrestricted'; // 内置助手授权不能扩大外部 MCP 令牌的能力。
  const port = await startMcpServer({ port: 39841, token: 'synthetic-only' });
  const client = new Client({ name: 'synthetic', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer synthetic-only' } },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['search_messages']);
    const result = await client.callTool({ name: 'execute_sql', arguments: {} });
    expect(result.isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }
});
