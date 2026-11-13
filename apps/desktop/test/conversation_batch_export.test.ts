// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationBatchSelection,
  conversationBatchTargets,
  createToolDraft,
  freezeToolTarget,
  type ConversationBatchTarget,
} from '../src/shared/content_selection';
import {
  planConversationBatchExport,
  startConversationBatchExport,
} from '../src/renderer/src/views/export/conversationBatchExport';
import { DEFAULT_OPTIONS, type ExportOptions } from '../src/renderer/src/views/export/types';
import { fixedScopeSummary } from '../src/renderer/src/views/export/exportScope';

const fixture = vi.hoisted(() => ({
  start: vi.fn(async (_input: unknown) => 'qq-task'),
  guild: vi.fn(async (_input: unknown) => 'guild-task'),
  generated: vi.fn(async (_input: unknown) => 'generated-task'),
  listGenerated: vi.fn(),
  getGenerated: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      startExport: { mutate: fixture.start },
      guildDirectStartExport: { mutate: fixture.guild },
      startGeneratedExport: { mutate: fixture.generated },
      generatedConversations: { query: fixture.listGenerated },
      generatedConversation: { query: fixture.getGenerated },
    },
  },
}));

const targets: ConversationBatchTarget[] = [
  { id: 'qq:friend', name: '合成好友', kind: 'c2c', ownerId: 'u_friend' },
  { id: 'qq:group', name: '合成群', kind: 'group', ownerId: '12345' },
  { id: 'official:uid', name: '合成公众号', kind: 'official', ownerId: 'u_official' },
  { id: 'service:app', name: '合成服务号', kind: 'service', ownerId: 'service-app' },
  { id: 'guild:node', name: '频道对话', kind: 'guild', ownerId: 'guild-node' },
  { id: 'clone:persona', name: '合成克隆', kind: 'persona', ownerId: 'persona', sessionId: null },
  {
    id: 'clone:group',
    name: '合成克隆群',
    kind: 'cloneGroup',
    ownerId: 'clone-group',
    sessionId: null,
  },
  {
    id: 'assistant:session',
    name: '合成助手对话',
    kind: 'assistant',
    sessionId: 'assistant-session',
  },
];
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-source' };
const savePolicy = { mode: 'before' as const, directory: '/synthetic/export' };
function run(
  selected: ConversationBatchTarget[],
  options: ExportOptions = structuredClone(DEFAULT_OPTIONS),
) {
  return startConversationBatchExport({
    plan: planConversationBatchExport(selected, ['json']),
    options,
    binding,
    savePolicy,
    isCurrent: () => true,
  });
}
beforeEach(() => {
  fixture.start.mockReset().mockResolvedValue('qq-task');
  fixture.guild.mockReset().mockResolvedValue('guild-task');
  fixture.generated.mockReset().mockResolvedValue('generated-task');
  fixture.listGenerated.mockReset().mockResolvedValue([]);
  fixture.getGenerated.mockReset().mockResolvedValue({ messages: [] });
});

describe('混合会话导出快照', () => {
  it('来源和真实身份随选区冻结，后续列表及草稿变化不污染任务', () => {
    const source = structuredClone(targets);
    const selection = conversationBatchSelection(source);
    const frozen = freezeToolTarget('account', createToolDraft('account', selection));
    source[0]!.ownerId = 'wrong';
    source.pop();
    expect(conversationBatchTargets(frozen.selection)).toEqual(targets);
    expect(fixedScopeSummary(selection)).toContain(String(targets.length));
    const limited = {
      ...selection,
      scope: { type: 'items' as const, ids: [targets[1]!.id, targets[4]!.id] },
    };
    expect(conversationBatchTargets(limited)).toEqual([targets[1], targets[4]]);
  });

  it('损坏、来源身份缺失、重复行及快照外目标明确失败，不缩小成其余对象', () => {
    const selection = conversationBatchSelection(targets);
    expect(() => conversationBatchSelection([targets[0]!, targets[0]!])).toThrow('重复');
    expect(() =>
      conversationBatchTargets({ ...selection, owner: { ...selection.owner, container: '{}' } }),
    ).toThrow('无效');
    expect(() =>
      conversationBatchTargets({
        ...selection,
        owner: { ...selection.owner, container: JSON.stringify([{ ...targets[4], ownerId: '' }]) },
      }),
    ).toThrow('不完整');
    expect(() =>
      conversationBatchTargets({ ...selection, scope: { type: 'items', ids: ['outside'] } }),
    ).toThrow('快照');
  });
});

describe('混合会话导出发起', () => {
  it('同批创建所有来源各自的任务，公众号和服务号保持真实消息源', async () => {
    const result = await run(targets, {
      ...structuredClone(DEFAULT_OPTIONS),
      completeMessages: true,
    });
    expect(result.created.map((item) => item.target.id)).toEqual(
      targets.map((target) => target.id),
    );
    expect(result.failed).toEqual([]);
    expect(fixture.start).toHaveBeenCalledTimes(4);
    expect(fixture.guild).toHaveBeenCalledOnce();
    expect(fixture.generated).toHaveBeenCalledTimes(3);
    for (const [index, kind] of ['c2c', 'group', 'official', 'service'].entries()) {
      expect(fixture.start.mock.calls[index]?.[0]).toMatchObject({
        ...binding,
        savePolicy,
        kind,
        conv: targets[index]!.ownerId,
        media: { completeMessages: index < 2 },
      });
    }
    expect(fixture.guild).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'guild-node',
        media: expect.objectContaining({ completeMessages: false }),
      }),
    );
    expect(
      fixture.generated.mock.calls.map(([input]) => (input as { target: unknown }).target),
    ).toEqual([
      { kind: 'persona', ownerId: 'persona', sessionId: null },
      { kind: 'group', ownerId: 'clone-group', sessionId: null },
      { kind: 'assistant', ownerId: 'assistant', sessionId: 'assistant-session' },
    ]);
  });

  it('每个不适用格式逐对象列明，原生生成记录不被伪装成HTML或ChatLab', () => {
    const plan = planConversationBatchExport(targets, ['html', 'json']);
    expect(plan.targets).toHaveLength(targets.length);
    expect(plan.unsupported.map((item) => item.target.id)).toEqual(
      targets.slice(5).map((target) => target.id),
    );
    expect(plan.targets[5]?.formats).toEqual(['json']);
    const htmlOnly = planConversationBatchExport(targets, ['html']);
    expect(htmlOnly.targets).toHaveLength(5);
    expect(htmlOnly.unsupported).toHaveLength(3);
    const chatlab = planConversationBatchExport(targets, ['json'], true);
    expect(chatlab.targets).toHaveLength(5);
    expect(chatlab.unsupported).toHaveLength(3);
  });

  it('一个目标启动失败继续其余对象，返回带对象名的失败清单供精确重试', async () => {
    fixture.start.mockRejectedValueOnce(new Error('合成的读取失败'));
    const result = await run(targets);
    expect(result.created).toHaveLength(targets.length - 1);
    expect(result.failed).toEqual([{ target: targets[0], reason: '合成的读取失败' }]);
    expect(fixture.guild).toHaveBeenCalledOnce();
    expect(fixture.generated).toHaveBeenCalledTimes(3);
  });

  it('生成对话按毫秒原始时间过滤，含起止边界，不扩大为全部历史', async () => {
    fixture.getGenerated.mockResolvedValue({
      messages: [
        { id: 'before', ts: 99999 },
        { id: 'start', ts: 100000 },
        { id: 'middle', ts: 150000 },
        { id: 'end', ts: 200000 },
        { id: 'after', ts: 200001 },
      ],
    });
    await run([targets[7]!], {
      ...structuredClone(DEFAULT_OPTIONS),
      range: { preset: 'custom', start: 100, end: 200 },
    });
    expect(fixture.generated).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: ['start', 'middle', 'end'] }),
    );
  });

  it('克隆缺少会话id时只接受单一长期对话，不能偷偷导出第一段旧子会话', async () => {
    fixture.listGenerated.mockResolvedValue([
      { kind: 'persona', ownerId: 'persona', sessionId: null },
    ]);
    const target = { ...targets[5]! };
    delete target.sessionId;
    const first = await run([target]);
    expect(first.created).toHaveLength(1);
    fixture.listGenerated.mockResolvedValue([
      { kind: 'persona', ownerId: 'persona', sessionId: 'first' },
      { kind: 'persona', ownerId: 'persona', sessionId: 'second' },
    ]);
    fixture.generated.mockClear();
    const ambiguous = await run([target]);
    expect(ambiguous.failed[0]?.reason).toContain('归一');
    expect(fixture.generated).not.toHaveBeenCalled();
  });

  it('在途修改和切号不重写后续目标或保存策略，切号后不再启动其他来源', async () => {
    let current = true;
    const source = structuredClone(targets);
    const plan = planConversationBatchExport(source, ['json']);
    const options = structuredClone(DEFAULT_OPTIONS);
    fixture.start.mockImplementationOnce(async () => {
      source[1]!.ownerId = 'changed';
      plan.targets[1]!.formats.push('txt');
      options.exportAvatar = false;
      return 'first';
    });
    await startConversationBatchExport({
      plan,
      options,
      binding,
      savePolicy,
      isCurrent: () => current,
    });
    expect(fixture.start.mock.calls[1]?.[0]).toMatchObject({
      conv: '12345',
      formats: ['json'],
      exportAvatar: true,
    });
    fixture.start.mockClear().mockImplementationOnce(async () => {
      current = false;
      return 'first';
    });
    fixture.guild.mockClear();
    fixture.generated.mockClear();
    const switched = await startConversationBatchExport({
      plan: planConversationBatchExport(targets, ['json']),
      options,
      binding,
      savePolicy,
      isCurrent: () => current,
    });
    expect(switched.created).toHaveLength(1);
    expect(switched.failed).toHaveLength(targets.length - 1);
    expect(fixture.guild).not.toHaveBeenCalled();
    expect(fixture.generated).not.toHaveBeenCalled();
  });
});
