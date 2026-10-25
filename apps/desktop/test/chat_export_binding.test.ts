import { beforeEach, expect, it, vi } from 'vitest';
import { startChatExportTasks } from '../src/renderer/src/views/export/chatExport';
import { DEFAULT_OPTIONS, type ExportFormat } from '../src/renderer/src/views/export/types';
const state = vi.hoisted(() => ({ start: vi.fn(async (_input: unknown) => 'task-a') }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { startExport: { mutate: state.start } } },
}));
beforeEach(() => state.start.mockReset().mockResolvedValue('task-a'));
it('批次每次建任务前检查来源，切换后停止未创建的目标', async () => {
  let current = true;
  const created = vi.fn();
  state.start.mockImplementationOnce(async () => {
    current = false;
    return 'first';
  });
  await expect(
    startChatExportTasks(
      [
        { id: 'u_a', name: '一' },
        { id: 'u_b', name: '二' },
      ],
      { ...DEFAULT_OPTIONS, ocrImages: false },
      ['json'],
      'json',
      {
        binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
        isCurrent: () => current,
        onTaskCreated: created,
      },
    ),
  ).rejects.toThrow(/已创建 1 个任务/);
  expect(state.start).toHaveBeenCalledOnce();
  expect(created).toHaveBeenCalledOnce();
  expect(created).toHaveBeenCalledWith('first');
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      conv: 'u_a',
    }),
  );
});
it('等待任务创建期间不借调用方后续修改改写格式、身份、范围或保存位置', async () => {
  const targets = [
    { id: 'u_a', name: '一', messageIds: ['1'] },
    { id: 'u_b', name: '二', messageIds: ['2'] },
  ];
  const options = structuredClone(DEFAULT_OPTIONS);
  options.ocrImages = false;
  const formats: ExportFormat[] = ['json'];
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    policy = { mode: 'before' as const, directory: '/chosen' };
  state.start.mockImplementationOnce(async () => {
    targets[1]!.id = 'u_wrong';
    targets[1]!.messageIds.push('wrong');
    binding.expectedAccountConfigId = 'source-b';
    policy.directory = '/wrong';
    formats.push('txt');
    options.exportAvatar = !options.exportAvatar;
    return 'first';
  });
  await startChatExportTasks(targets, options, formats, 'json', {
    binding,
    savePolicy: policy,
    baselineDirectory: '/baseline',
  });
  expect(state.start).toHaveBeenLastCalledWith(
    expect.objectContaining({
      conv: 'u_b',
      baselineDirectory: '/baseline',
      filter: { messageIds: ['2'] },
      expectedAccountConfigId: 'source-a',
      savePolicy: { mode: 'before', directory: '/chosen' },
      formats: ['json'],
      exportAvatar: DEFAULT_OPTIONS.exportAvatar,
    }),
  );
});

it('每会话选择生效，明确新建不会退回上级文件夹自动套用基线', async () => {
  await startChatExportTasks(
    [
      { id: 'u_a', name: '新建' },
      { id: 'u_b', name: '增量' },
    ],
    { ...DEFAULT_OPTIONS, ocrImages: false },
    ['json'],
    'json',
    {
      baselineDirectory: '/parent',
      baselineByConversation: { 'c2c:u_a': '', 'c2c:u_b': '/parent/selected' },
    },
  );
  expect(state.start.mock.calls[0]?.[0]).toMatchObject({
    conv: 'u_a',
    baselineDirectory: undefined,
  });
  expect(state.start.mock.calls[1]?.[0]).toMatchObject({
    conv: 'u_b',
    baselineDirectory: '/parent/selected',
  });
});
