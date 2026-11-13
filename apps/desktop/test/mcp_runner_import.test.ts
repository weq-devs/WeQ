// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { AI_TOOLS } from '../src/main/mcp/tools';
import { runAssistantTool } from '../src/main/mcp/openai_tools';

vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { msgDbPath: '/synthetic/mcp-runner-import.db' },
    services: { assistant: { getConfig: () => ({ permissionMode: 'sandbox' }) } },
  }),
}));

it('真实工具注册表与执行器的循环引用初始化后，run_js 可继续调用只读工具', async () => {
  expect(AI_TOOLS.some((tool) => tool.name === 'run_js')).toBe(true);
  const result = await runAssistantTool('run_js', {
    code: 'const snapshot = await callTool("get_message_performance", {}); return typeof snapshot.database.jsQueueWait.count === "number";',
    timeoutMs: 2000,
  });
  expect(result).toMatchObject({
    ok: true,
    result: true,
    calls: [expect.objectContaining({ name: 'get_message_performance', ok: true })],
  });
});

it('改为静态导入不改变嵌套调用的沙箱权限检查', async () => {
  const result = await runAssistantTool('run_js', {
    code: 'return await callTool("send_text_message", {});',
    timeoutMs: 2000,
  });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('沙箱模式') });
});
