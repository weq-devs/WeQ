/**
 * 在线 action 封装的离线单测：群管理 / 群文件 / 收藏表情 / 加群请求 / 禁言列表。
 *
 * 用最小 native stub 断言实际发出的命令、needSign 与参数映射；不联网。
 */

import { describe, expect, it, vi } from 'vitest';
import { decode, encode } from '@weqbot/protocol';
import {
  CreateGroupFolder,
  DeleteGroupFile,
  FetchGroupDetail,
  GetGroupJoinInfo,
  DeleteGroupFolder,
  FetchGroupMemberListPage,
  GetGroupMessagePolicies,
  FetchGroupRequests,
  oidbCommand,
  resolveSign,
  ReadedReport,
  ReportGroupNoticeRead,
  MoveGroupFile,
  RenameGroupFile,
  RenameGroupFolder,
  GroupTodo,
  LeaveGroup,
  SetGroupRequest,
  type GroupMemberListItem,
} from '@weqbot/protocol';
import { GroupModerationService } from '../src/account/group_moderation';
import { GroupFileService } from '../src/account/group_file';
import { GroupInfoService } from '../src/account/group_info';
import { GroupNotifyService } from '../src/account/group_notify';

interface Call {
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
  needSign?: boolean;
}

function makeNative(replies: Map<string, Uint8Array> = new Map()) {
  const calls: Call[] = [];
  return {
    calls,
    sendOidbPacket: async (
      _pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
      needSign?: boolean,
    ): Promise<Buffer> => {
      calls.push({ command, subCommand, body: new Uint8Array(body), isUid, needSign });
      const key = `${command.toString(16)}_${subCommand}`;
      return Buffer.from(replies.get(key) ?? new Uint8Array(0));
    },
  };
}

describe('群消息策略在线读回', () => {
  it('同一 PID 的并发读取合并，不以本地缓存代替未返回的群', async () => {
    const reply = encode(GetGroupMessagePolicies.respSchema, {
      groups: [
        { groupId: 123, personal: { policy: 3 } },
        { groupId: 456, personal: { policy: 4 } },
      ],
    });
    const nt = makeNative(
      new Map([
        [
          `${GetGroupMessagePolicies.command.toString(16)}_${GetGroupMessagePolicies.subCommand}`,
          reply,
        ],
      ]),
    );
    const service = new GroupInfoService({} as never, { nt, resolvePid: () => 1 });
    const [first, second] = await Promise.all([
      service.getMessagePolicy(123),
      service.getMessagePolicy(456),
    ]);
    expect(first.policy).toBe(3);
    expect(second.policy).toBe(4);
    expect(nt.calls).toHaveLength(1);
    await expect(service.getMessagePolicy(999)).rejects.toThrow('未返回该群');
    expect(nt.calls).toHaveLength(2);
  });
  it('读取途中 QQ 运行时改变时拒绝旧 PID 的策略', async () => {
    let pid = 1;
    let finish!: (data: Buffer) => void;
    const nt = {
      sendOidbPacket: vi.fn(
        () =>
          new Promise<Buffer>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const service = new GroupInfoService({} as never, { nt, resolvePid: () => pid });
    const pending = service.getMessagePolicy(123);
    pid = 2;
    finish(
      Buffer.from(
        encode(GetGroupMessagePolicies.respSchema, {
          groups: [{ groupId: 123, personal: { policy: 3 } }],
        }),
      ),
    );
    await expect(pending).rejects.toThrow('运行时已切换');
  });
});

describe('GroupModerationService', () => {
  it('退群 / 群待办走对应命令', async () => {
    const nt = makeNative();
    const svc = new GroupModerationService(nt, () => 7);

    await svc.leaveGroup('123');
    await svc.setTodo('123', 9, 'set');
    await svc.getTodoList('123');

    expect(nt.calls.map((c) => [c.command, c.subCommand])).toEqual([
      [LeaveGroup.command, LeaveGroup.subCommand],
      [GroupTodo.command, 1],
      [0x9474, 0],
    ]);
  });

  it('setAddOption 透传问题与答案', async () => {
    const nt = makeNative();
    const svc = new GroupModerationService(nt, () => 1);
    await svc.setAddOption({ groupId: '123', addType: 4, groupQuestion: 'q', groupAnswer: 'a' });
    expect(nt.calls[0]).toMatchObject({ command: 0x89a, subCommand: 0, needSign: true });
    // 问题 / 答案必须真的在 wire 上（tag 30 / 31）。
    const hex = Buffer.from(nt.calls[0]!.body).toString('hex');
    expect(hex).toContain(Buffer.from('q').toString('hex'));
    expect(hex).toContain(Buffer.from('a').toString('hex'));
  });

  it('从 0x88D_0 群管理详情读取档位和问答，不使用省略问题的公开详情', async () => {
    const reply = encode(FetchGroupDetail.respSchema, {
      groupInfo: {
        uin: 123,
        results: { uin: 723123, addType: 4, question: '合成问题', answer: '合成答案' },
      },
    });
    const nt = makeNative(new Map([['88d_0', reply]]));
    const svc = new GroupModerationService(nt, () => 7);
    await expect(svc.joinValidation(123)).resolves.toEqual({
      option: 4,
      question: '合成问题',
    });
    await expect(svc.joinSettings(123)).resolves.toEqual({
      option: 4,
      question: '合成问题',
      answer: '合成答案',
    });
    expect(nt.calls).toHaveLength(2);
    expect(nt.calls[0]).toMatchObject({ command: 0x88d, subCommand: 0 });
    const validation = decode(FetchGroupDetail.reqSchema, nt.calls[0]!.body);
    const verification = decode(FetchGroupDetail.reqSchema, nt.calls[1]!.body);
    expect(validation).toMatchObject({ config: { flags: { question: '' } } });
    expect(validation).not.toHaveProperty('config.flags.answer');
    expect(verification).toMatchObject({ config: { flags: { question: '', answer: '' } } });
  });

  it.each([
    { uin: 456, result: 0, error: '群号不一致' },
    { uin: 123, result: 72, error: '72' },
  ])('拒绝 0x88D_0 错群或失败回包 %#', async ({ uin, result, error }) => {
    const reply = encode(FetchGroupDetail.respSchema, {
      groupInfo: { uin, result, results: { uin: 123, addType: 4, question: '合成问题' } },
    });
    const nt = makeNative(new Map([['88d_0', reply]]));
    const svc = new GroupModerationService(nt, () => 1);
    await expect(svc.joinValidation(123)).rejects.toThrow(error);
  });

  it('公开资料保留分类字段，跳过请求和使用旧接口的题目', async () => {
    const reply = encode(GetGroupJoinInfo.respSchema, {
      groups: [{ groupCode: 123, result: 0, info: { categoryId: 37, question: '旧问题' } }],
    });
    const nt = makeNative(new Map([['88d_110', reply]]));
    const svc = new GroupInfoService({} as never, { nt, resolvePid: () => 1 });
    await expect(svc.getJoinInfo(123)).resolves.toMatchObject({ categoryId: 37, question: null });
    expect(nt.calls[0]).toMatchObject({ command: 0x88d, subCommand: 110 });
    const request = decode(GetGroupJoinInfo.reqSchema, nt.calls[0]!.body);
    expect(request).toMatchObject({ groups: [{ info: { categoryId: 0 } }] });
    expect(request).not.toHaveProperty('groups.0.info.question');
  });
});

describe('GroupFileService', () => {
  it('文件 / 文件夹写操作映射到 0x6D6 / 0x6D7 / 0x6D8', async () => {
    const nt = makeNative(
      new Map([
        ['6d6_3', encode(DeleteGroupFile.respSchema, { delete: { retCode: 0 } })],
        ['6d6_4', encode(RenameGroupFile.respSchema, { rename: { retCode: 0 } })],
        ['6d6_5', encode(MoveGroupFile.respSchema, { move: { retCode: 0 } })],
        ['6d7_0', encode(CreateGroupFolder.respSchema, { create: { retCode: 0 } })],
        ['6d7_1', encode(DeleteGroupFolder.respSchema, { delete: { retCode: 0 } })],
        ['6d7_2', encode(RenameGroupFolder.respSchema, { rename: { retCode: 0 } })],
      ]),
    );
    const svc = new GroupFileService(nt, {} as never, () => 1);

    await svc.deleteFile(123, 'f1');
    await svc.renameFile(123, 'f1', '/', 'n.txt');
    await svc.moveFile(123, 'f1', '/', 'dir');
    await svc.createFolder(123, '/', 'docs');
    await svc.deleteFolder(123, 'D1');
    await svc.renameFolder(123, 'D1', 'docs2');
    await svc.count(123);
    await svc.space(123);

    expect(nt.calls.map((c) => [c.command, c.subCommand])).toEqual([
      [0x6d6, 3],
      [0x6d6, 4],
      [0x6d6, 5],
      [0x6d7, 0],
      [0x6d7, 1],
      [0x6d7, 2],
      [0x6d8, 2],
      [0x6d8, 3],
    ]);
  });
});

describe('GroupNotifyService', () => {
  it('群通知只上报实际展示的序号，以独立读回确认，并保留后来条目', async () => {
    const viewed = 9007199254740993n;
    const newer = viewed + 1n;
    const replies = new Map<string, Uint8Array>();
    const page = (boundary: bigint) =>
      encode(FetchGroupRequests.respSchema, {
        newLatestSeq: newer,
        field5: boundary,
        requests: [
          { sequence: viewed, eventType: 1 },
          { sequence: newer, eventType: 1 },
        ],
      });
    replies.set('10c0_1', page(viewed - 1n));
    const transport = makeNative(replies);
    const nt = {
      ...transport,
      sendOidbPacket: vi.fn(async (...args: Parameters<typeof transport.sendOidbPacket>) => {
        const body = await transport.sendOidbPacket(...args);
        if (args[1] === 0x113b) replies.set('10c0_1', page(viewed));
        return body;
      }),
    };
    const service = new GroupNotifyService({} as never, { nt, resolvePid: () => 1 });
    const [first, duplicate] = await Promise.all([
      service.reportNoticeRead(viewed, () => undefined),
      service.reportNoticeRead(viewed, () => undefined),
    ]);
    expect([first, duplicate]).toEqual([viewed, viewed]);
    expect(transport.calls.map(({ command }) => command)).toEqual([0x10c0, 0x113b, 0x10c0, 0x10c0]);
    expect(transport.calls[1]).toMatchObject({ subCommand: 1, isUid: false, needSign: false });
    expect(decode(ReportGroupNoticeRead.reqSchema, transport.calls[1]!.body)).toEqual({
      sequence: viewed,
    });
    const inbox = await service.fetchOnlineInbox({ maxPages: 1 });
    expect(
      inbox.requests
        .map(({ rawSequence }) => rawSequence)
        .filter((seq) => seq! > inbox.readSequence!),
    ).toEqual([newer]);
  });

  it('换号或缺少读取水位时不发送群通知已读', async () => {
    const ready = encode(FetchGroupRequests.respSchema, { newLatestSeq: 900n, field5: 500n });
    const replies = new Map([['10c0_1', ready]]);
    const transport = makeNative(replies);
    const service = new GroupNotifyService({} as never, { nt: transport, resolvePid: () => 1 });
    const current = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('账号已切换');
      });
    await expect(service.reportNoticeRead(800n, current)).rejects.toThrow('账号已切换');
    replies.set('10c0_1', encode(FetchGroupRequests.respSchema, { newLatestSeq: 900n }));
    await expect(service.reportNoticeRead(800n, () => undefined)).resolves.toBeUndefined();
    expect(transport.calls.map(({ command }) => command)).toEqual([0x10c0, 0x10c0]);
  });

  it('fetchOnlineRequests 翻页并按 cookie 停止', async () => {
    const encoded = encode(FetchGroupRequests.respSchema, {
      requests: [
        {
          sequence: 11,
          eventType: 2,
          state: 1,
          group: { groupUin: 123, groupName: 'g' },
          target: { uin: 456, name: 'u' },
        },
      ],
      cookie: 0,
    });
    const nt = makeNative(new Map([['10c0_1', encoded]]));
    const svc = new GroupNotifyService({} as never, { nt, resolvePid: () => 1 });
    const list = await svc.fetchOnlineRequests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ groupId: 123, sequence: 11, eventType: 2 });
    expect(nt.calls[0]).toMatchObject({
      command: 0x10c0,
      subCommand: 1,
      needSign: resolveSign(oidbCommand(FetchGroupRequests.command, 1)).needSign,
    });
  });

  it('handleOnlineRequest：空理由写空格，并透传 operateTransInfo', async () => {
    const nt = makeNative();
    const svc = new GroupNotifyService({} as never, { nt, resolvePid: () => 1 });
    await svc.handleOnlineRequest(
      {
        groupId: 123,
        sequence: 11,
        eventType: 7,
        filtered: false,
        operateTransInfo: new Uint8Array([1, 2]),
      },
      false,
    );
    expect(nt.calls[0]).toMatchObject({ command: 0x10c8, subCommand: 1 });
    const body = decode(SetGroupRequest.reqSchema, nt.calls[0]!.body) as {
      accept: number;
      body: { message: string; operateTransInfo: Uint8Array; eventType: number };
    };
    expect(body.accept).toBe(2);
    expect(body.body.message).toBe(' ');
    expect(body.body.eventType).toBe(1);
    expect(Array.from(body.body.operateTransInfo)).toEqual([1, 2]);
  });
});

describe('GroupInfoService 禁言列表', () => {
  it('在线拉取失败时回退本地 group_member3', async () => {
    const now = Math.floor(Date.now() / 1000);
    const session = {
      groupMembers: {
        listMembersInGroup: vi.fn(async () => [
          { uid: 'u1', uin: 1n, nick: 'a', card: '', muteUntil: now + 100 },
          { uid: 'u2', uin: 2n, nick: 'b', card: '', muteUntil: 0 },
        ]),
      },
    };
    const nt = makeNative();
    nt.sendOidbPacket = async () => {
      throw new Error('offline');
    };
    const svc = new GroupInfoService(session as never, { nt, resolvePid: () => 1 });
    const muted = await svc.listMutedMembers(123n);
    expect(muted).toHaveLength(1);
    expect(muted[0]).toMatchObject({ uid: 'u1', muteUntil: now + 100 });
  });

  it('在线成功时返回 shutUpTime > now 的成员，并缓存', async () => {
    const now = Math.floor(Date.now() / 1000);
    const members: GroupMemberListItem[] = [
      {
        uin: 1,
        uid: 'u1',
        nickname: 'a',
        card: '',
        permission: 0,
        level: 0,
        specialTitle: '',
        joinTime: 0,
        lastSentTime: 0,
        shutUpTime: now + 50,
      },
      {
        uin: 2,
        uid: 'u2',
        nickname: 'b',
        card: '',
        permission: 0,
        level: 0,
        specialTitle: '',
        joinTime: 0,
        lastSentTime: 0,
        shutUpTime: 0,
      },
    ];
    // 走线的是 `memberCard` / `level` 等嵌套消息；这里复用 spec 的 serialize 生成
    // 与真实请求等价的 wire 形态，避免测试里手拼字段名。
    const resp = encode(FetchGroupMemberListPage.respSchema, {
      members: members.map((m) => ({
        uin: { uid: m.uid, uin: m.uin },
        memberName: m.nickname,
        memberCard: { memberCard: m.card },
        level: { level: m.level },
        specialTitle: m.specialTitle,
        joinTimestamp: m.joinTime,
        lastMsgTimestamp: m.lastSentTime,
        shutUpTimestamp: m.shutUpTime,
        permission: m.permission,
      })),
    });
    const nt = makeNative(new Map([['fe7_3', resp]]));
    const svc = new GroupInfoService({} as never, { nt, resolvePid: () => 1 });

    const first = await svc.listMutedMembers(123n);
    const second = await svc.listMutedMembers(123n);
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    // 第二次命中 60s 缓存，不再发包。
    expect(nt.calls).toHaveLength(1);
  });
});

describe('MessageSendService 标记已读', () => {
  it('两段式：先探测，再只推进落后会话', async () => {
    const { MessageSendService } = await import('../src/account/message_send');
    const calls: { cmd: string; body: Uint8Array; needSign?: boolean }[] = [];
    let round = 0;
    const nt = {
      sendOidbPacket: async (): Promise<Buffer> => Buffer.alloc(0),
      sendPacket: async (
        _pid: number,
        cmd: string,
        body: Buffer,
        needSign?: boolean,
      ): Promise<Buffer> => {
        calls.push({ cmd, body: new Uint8Array(body), needSign });
        round += 1;
        // 第一包回「落后」，第二包回「已追上」。
        const behind = round % 2 === 1;
        return Buffer.from(
          encode(ReadedReport.respSchema, {
            groupList: [{ groupUin: 123, readSeq: 1, latestSeq: behind ? 5 : 1, resultCode: 0 }],
          }),
        );
      },
    };
    const session = {
      context: { uin: '10001' },
      uidMap: { uidByUin: (uin: bigint) => (uin === 20002n ? 'uid-20002' : undefined) },
    };
    const svc = new MessageSendService(nt as never, session as never, () => 1);

    await svc.markGroupsRead([123]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      cmd: 'trpc.msg.msg_svc.MsgService.SsoReadedReport',
      needSign: true,
    });
    // 探测阶段水位 0 按 proto3 省略，只在 wire 上留 groupUin。
    expect(decode(ReadedReport.reqSchema, calls[0]!.body)).toMatchObject({
      groupList: [{ groupUin: 123n }],
    });
    expect(decode(ReadedReport.reqSchema, calls[1]!.body)).toMatchObject({
      groupList: [{ groupUin: 123n, lastReadSeq: 5n }],
    });

    calls.length = 0;
    await svc.markPrivateRead(['20002']);
    expect(decode(ReadedReport.reqSchema, calls[0]!.body)).toMatchObject({
      c2cList: [{ uid: 'uid-20002' }],
    });

    await expect(svc.markPrivateRead(['99999'])).rejects.toThrow('本地 uid 目录');
  });
});
