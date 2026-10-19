import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { GroupMsg, GroupTodo } from '@weq/db';
import { GroupInfoService } from '../src/account/group_info';

/**
 * `GroupInfoService.getGroupTodos` 的「横幅 + 原消息」组合逻辑。
 *
 * 样本取自真实安卓备份：`group_todo_top_banner` 里一条「图片」待办指向
 * `seq=496943`，而本地消息库里同 seq 只有一条「设置了群待办」灰条（原消息已被
 * 撤回）—— 这种情况要如实报 `messageFound = false`，不能把灰条当正文。
 */

const todo = (over: Partial<GroupTodo> = {}): GroupTodo => ({
  groupCode: '10001',
  msgSeq: 100n,
  msgRandom: 200n,
  text: '[图片]',
  preText: '群待办｜',
  iconUrl: 'https://p.iqun.qq.com/x.png',
  jumpType: 3,
  jumpParam: '{"seq":100,"random":200}',
  createTime: 10,
  updateTime: 11,
  expireTime: 12,
  bannerType: 2,
  ...over,
});

const msg = (over: Partial<GroupMsg> = {}): GroupMsg =>
  ({
    msgId: 1n,
    senderUid: 'u_sender',
    targetGroupCode: '10001',
    senderUin: 12345n,
    sendTime: 1000n,
    elements: [{ kind: 'text', textContent: '原文' }],
    msgSeq: 100n,
    msgType: 2n,
    subType: 1n,
    msgRandom: 200n,
    ...over,
  }) as GroupMsg;

function setup(todos: GroupTodo[], messages: GroupMsg[]) {
  const session = {
    groupTodos: {
      listAll: vi.fn(async () => todos),
      getForGroup: vi.fn(
        async (code: bigint) => todos.find((t) => t.groupCode === code.toString()) ?? null,
      ),
    },
    groupMsgs: {
      listBySeqsInPartition: vi.fn(async (_code: string, _seqs: bigint[]) => messages),
    },
  } as unknown as AccountSession;
  return { service: new GroupInfoService(session), session };
}

describe('GroupInfoService.getGroupTodos', () => {
  it('attaches the original message elements', async () => {
    const { service } = setup([todo()], [msg()]);
    const [view] = await service.getGroupTodos(10001n);

    expect(view).toMatchObject({
      groupCode: '10001',
      msgSeq: 100n,
      text: '[图片]',
      senderUid: 'u_sender',
      sendTime: 1000,
      messageFound: true,
    });
    expect(view?.elements).toEqual([expect.objectContaining({ type: 'text' })]);
  });

  it('picks the row with the matching msgRandom when a seq has several rows', async () => {
    const { service } = setup(
      [todo()],
      [
        msg({
          msgRandom: 999n,
          elements: [{ kind: 'text', textContent: '灰条' }] as GroupMsg['elements'],
        }),
        msg({
          msgRandom: 200n,
          elements: [{ kind: 'text', textContent: '正文' }] as GroupMsg['elements'],
        }),
      ],
    );
    const [view] = await service.getGroupTodos(10001n);
    expect(view?.messageFound).toBe(true);
    const first = view?.elements[0] as { data: { textContent?: string } } | undefined;
    expect(first?.data.textContent).toBe('正文');
  });

  it('reports messageFound = false when only the 设置群待办 gray tip survives', async () => {
    const { service } = setup(
      [todo()],
      [
        msg({
          msgRandom: 7790081453056557678n,
          elements: [
            { kind: 'grayTipXml', subType: 12, grayTipXmlContent: '<gtip/>' },
          ] as GroupMsg['elements'],
        }),
      ],
    );
    const [view] = await service.getGroupTodos(10001n);
    expect(view?.messageFound).toBe(false);
    expect(view?.elements).toEqual([]);
    // 摘要还在，前端可以退回只画横幅。
    expect(view?.text).toBe('[图片]');
  });

  it('returns [] when the group has no todo / the table is absent', async () => {
    const { service } = setup([], []);
    await expect(service.getGroupTodos(10001n)).resolves.toEqual([]);
    await expect(service.getGroupTodos()).resolves.toEqual([]);
  });

  it('keeps the banner when the local message DB lookup throws', async () => {
    const session = {
      groupTodos: { listAll: vi.fn(async () => [todo()]), getForGroup: vi.fn() },
      groupMsgs: {
        listBySeqsInPartition: vi.fn(async () => {
          throw new Error('no such table');
        }),
      },
    } as unknown as AccountSession;
    const service = new GroupInfoService(session);
    const [view] = await service.getGroupTodos();
    expect(view?.messageFound).toBe(false);
    expect(view?.text).toBe('[图片]');
  });
});
