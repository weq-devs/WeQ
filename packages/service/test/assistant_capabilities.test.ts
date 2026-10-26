import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantService, type AssistantToolSpec } from '../src/account/assistant';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { TokenUsageStore } from '../src/account/agentlab_usage';
import { assistantCapabilityGuidance } from '../src/account/assistant_capabilities';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function requestPrompt(
  names: string[],
  permissionMode: 'sandbox' | 'unrestricted' = 'sandbox',
) {
  const dir = mkdtempSync(join(tmpdir(), 'weq-assistant-capabilities-'));
  dirs.push(dir);
  const specs: AssistantToolSpec[] = names.map((name) => ({
    type: 'function',
    function: { name, description: '合成工具', parameters: { type: 'object', properties: {} } },
  }));
  const run = vi.fn();
  const service = new AssistantService(
    dir,
    () => ({ baseUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture' }),
    new TokenUsageStore(join(dir, 'usage.json')),
    new ConversationStore(join(dir, 'conversations.json')),
    { specs: async () => specs, run },
  );
  service.setConfig({
    model: { providerId: 'fixture', model: 'fixture' },
    permissionMode,
    confirmUnrestricted: true,
  });
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        'data: {"choices":[{"delta":{"content":"合成回答"}}]}\n\ndata: [DONE]\n\n',
      );
    }),
  );
  await service.chat(service.createSession().id, '查一下当前能力');
  expect(run).not.toHaveBeenCalled();
  return bodies[0]!.messages[0]!.content;
}

it('实际请求包含按本轮工具生成的能力指引，不把界面能力当作助手能力', async () => {
  const prompt = await requestPrompt(['get_message_details', 'transcribe_voice_message']);
  expect(prompt).toContain('【本轮能力与边界】');
  expect(prompt).toContain('transcript');
  expect(prompt).toContain('不能把界面已有功能当成可调用工具');
  expect(prompt).not.toContain('list_db_columns');
});

it('未注册的能力不注入操作指引，外部 MCP 不冒充同名内置能力', async () => {
  const prompt = await requestPrompt(['mcp__fixture__grab_red_bag']);
  expect(prompt).not.toContain('selfClaim');
  expect(prompt).not.toContain('领取金额');
  expect(prompt).not.toContain('纯文字导出');
});

it('组合指引要求依赖工具全部存在，移除工具后不会沿用旧指引', () => {
  expect(assistantCapabilityGuidance(['transcribe_voice_message'])).not.toContain('transcript');
  expect(
    assistantCapabilityGuidance(['get_message_details', 'transcribe_voice_message']),
  ).toContain('transcript');
  expect(assistantCapabilityGuidance([])).not.toContain('transcript');
  expect(assistantCapabilityGuidance(['get_red_bag_detail'])).not.toContain('selfClaim');
});

it('纯统计问题不再强制读取原文，未知范围不要求穷尽全库', async () => {
  const prompt = await requestPrompt(['get_period_overview']);
  expect(prompt).toContain('无需为纯统计问题额外读取聊天原文');
  expect(prompt).toContain('不穷尽全库');
});

it('红包、导出和数据库的指引跟随工具清单，区分下单与付款', async () => {
  const prompt = await requestPrompt([
    'pack_red_bag',
    'get_red_bag_detail',
    'grab_red_bag',
    'export_conversation',
    'get_db_columns',
  ]);
  expect(prompt).toContain('下单出码不等于付款');
  expect(prompt).toContain('selfClaim');
  expect(prompt).toContain('纯文字导出');
  expect(prompt).toContain('get_db_columns');
});

it.each(['sandbox', 'unrestricted'] as const)(
  '实际 %s 请求明确说明宿主权限而不沿用另一模式的限制',
  async (mode) => {
    const prompt = await requestPrompt(['run_js'], mode);
    if (mode === 'sandbox') {
      expect(prompt).toContain('本轮权限：沙箱模式');
      expect(prompt).toContain('没有 fs / fetch');
      expect(prompt).not.toContain('可运行 Node 宿主代码');
    } else {
      expect(prompt).toContain('本轮权限：任意权限');
      expect(prompt).toContain('可运行 Node 宿主代码');
      expect(prompt).toContain('删除外部文件');
      expect(prompt).not.toContain('没有 fs / fetch');
    }
  },
);
