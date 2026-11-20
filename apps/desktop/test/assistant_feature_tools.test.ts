// @vitest-environment node
import { aiToolSpecs, runAssistantTool } from '../src/main/mcp/openai_tools';
import { bindAccountTools } from '../src/main/mcp/account_scope';
import { expect, it, vi } from 'vitest';

vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: {},
    services: {},
    bootstrap: { agentLabConfig: { getDefaultModelStatus: () => ({ available: false }) } },
  }),
}));

it('助手默认工具规格和执行都能查目录，结果只认本轮收到的工具名', async () => {
  const specs = aiToolSpecs({ permissionMode: 'sandbox' }).map((spec) => spec.function.name);
  expect(specs).toContain('list_features');
  expect(specs).toContain('get_feature');
  const account = {};
  const run = bindAccountTools(account, () => account, runAssistantTool);
  const options = {
    permissionMode: 'sandbox',
    visibleToolNames: ['list_conversations', 'get_feature'],
    featureLinks: true,
  } as const;
  expect(
    await run('get_feature', { id: 'messages.inbox', client: 'desktop' }, options),
  ).toMatchObject({
    entry: { status: 'available' },
    navigation: { url: 'https://weq-feature.invalid/open/messages.inbox' },
    tools: [
      { name: 'list_conversations', exposed: true },
      { name: 'get_messages', exposed: false },
    ],
  });
  expect(
    await run('get_feature', { id: 'setting:llm-default-model', client: 'desktop' }, options),
  ).toMatchObject({
    entry: { status: 'available' },
    operation: { status: 'unavailable', reason: 'default-chat-model' },
    navigation: { url: 'https://weq-feature.invalid/open/setting%3Allm-default-model' },
  });
});
