/**
 * 新增群管理 / 群文件 / 群待办 / 群打卡命令的离线单测。
 *
 * 覆盖：请求编码（黄金字节或结构断言）、路由（command/subCommand/isUid）、
 * needSign（按 LagrangeV2 白名单推导）、响应解析。
 *
 * 字段布局来源：SnowLuma `proto-defs/oidb-actions/*` 与
 * `oidb-services/{group-admin,group-file,extras,misc}/*`。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import {
  AddGroupCategoryTag,
  CreateGroupFolder,
  DeleteGroupAlbumMedia,
  DeleteGroupFile,
  DeleteGroupFolder,
  DeleteGroupCategoryTag,
  FetchGroupMemberListPage,
  GetGroupAtAllRemain,
  GetGroupCategoryTags,
  GetGroupFileCount,
  GetGroupFileSpace,
  GetGroupTodoList,
  GroupTodo,
  LeaveGroup,
  MoveGroupFile,
  RenameGroupFile,
  RenameGroupFolder,
  SendGroupSign,
  SetGroupAddOption,
  SetGroupRequest,
  ClickInlineKeyboardButton,
  HandleFriendRequest,
  FetchGroupRequests,
  SetOnlineStatus,
  SetSelfLongNick,
  ReadedReport,
} from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
  needSign?: boolean;
}

function makeNative(reply: Uint8Array = new Uint8Array(0)) {
  const calls: OidbCall[] = [];
  return {
    calls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
      needSign?: boolean,
    ): Promise<Buffer> => {
      calls.push({ pid, command, subCommand, body: new Uint8Array(body), isUid, needSign });
      return Buffer.from(reply);
    },
  };
}

function makePacketNative(reply: Uint8Array = new Uint8Array(0)) {
  const calls: { pid: number; cmd: string; body: Uint8Array; needSign?: boolean }[] = [];
  return {
    calls,
    sendPacket: async (
      pid: number,
      cmd: string,
      body: Buffer,
      needSign?: boolean,
    ): Promise<Buffer> => {
      calls.push({ pid, cmd, body: new Uint8Array(body), needSign });
      return Buffer.from(reply);
    },
  };
}

describe('群管理 / 群文件 / 群待办', () => {
  it('LeaveGroup：0x1097_1，不签名', async () => {
    const nt = makeNative();
    await LeaveGroup.invoke(nt, 7, { groupId: 12345 });
    expect(nt.calls[0]).toMatchObject({
      pid: 7,
      command: 0x1097,
      subCommand: 1,
      isUid: false,
      needSign: false,
    });
    expect(nt.calls[0]!.body).toEqual(hexToBytes('08 b9 60'));
  });

  it('SetGroupAddOption：0x89a_0，签名；type 55 线上写 5，只有 4 保留答案', async () => {
    const nt = makeNative();
    await SetGroupAddOption.invoke(nt, 1, {
      groupId: 100,
      addType: 55,
      groupQuestion: 'q',
      groupAnswer: 'a',
    });
    const call = nt.calls[0]!;
    expect(call).toMatchObject({ command: 0x89a, subCommand: 0, needSign: true });
    const body = decode(SetGroupAddOption.reqSchema, call.body);
    expect((body.settings as Record<string, unknown>).addType).toBe(5);
    expect((body.settings as Record<string, unknown>).groupAnswer).toBe('');
    // 空串必须真的上线（不能因 proto3 省略规则被吞）：tag 30/31 的 key 是 f2 01 / fa 01。
    expect(Array.from(call.body)).toEqual(expect.arrayContaining([0xf2, 0x01, 0xfa, 0x01]));
  });

  it('GetGroupAtAllRemain：0x8a7_0，basic 三元组与 selfUin', async () => {
    const nt = makeNative();
    await GetGroupAtAllRemain.invoke(nt, 1, { groupId: 100, selfUin: 200 });
    const call = nt.calls[0]!;
    expect(call).toMatchObject({ command: 0x8a7, subCommand: 0, needSign: false });
    const body = decode(GetGroupAtAllRemain.reqSchema, call.body);
    expect(body).toMatchObject({
      basic1: 1,
      basic2: 2,
      basic3: 1,
      uin: 200n,
      groupId: 100n,
    });
  });

  it('群分类标签：0x967c / 967d / 967e_0，均不签名', async () => {
    const nt = makeNative();
    await GetGroupCategoryTags.invoke(nt, 1, { groupClass: 0 });
    await AddGroupCategoryTag.invoke(nt, 1, { groupClass: 2, name: 'tag' });
    await DeleteGroupCategoryTag.invoke(nt, 1, { groupClass: 2, name: 'tag' });
    expect(nt.calls.map((c) => [c.command, c.subCommand, c.needSign])).toEqual([
      [0x967c, 0, false],
      [0x967d, 0, false],
      [0x967e, 0, false],
    ]);
    // groupClass=0 是合法值，必须显式上线。
    expect(decode(GetGroupCategoryTags.reqSchema, nt.calls[0]!.body).groupClass).toBe(0);
  });

  it('FetchGroupMemberListPage：0xfe7_3，签名；解析成员与 token', async () => {
    const resp = encode(FetchGroupMemberListPage.respSchema, {
      members: [
        {
          uin: { uid: 'u1', uin: 123 },
          memberName: 'nick',
          memberCard: { memberCard: 'card' },
          level: { level: 9 },
          specialTitle: 'title',
          joinTimestamp: 1,
          lastMsgTimestamp: 2,
          shutUpTimestamp: 3,
          permission: 2,
        },
      ],
      token: 'next',
    });
    const nt = makeNative(resp);
    const page = await FetchGroupMemberListPage.invoke(nt, 1, { groupId: 100 });
    expect(nt.calls[0]).toMatchObject({ command: 0xfe7, subCommand: 3, needSign: true });
    expect(page).toEqual({
      members: [
        {
          uin: 123,
          uid: 'u1',
          nickname: 'nick',
          card: 'card',
          permission: 2,
          level: 9,
          specialTitle: 'title',
          joinTime: 1,
          lastSentTime: 2,
          shutUpTime: 3,
        },
      ],
      token: 'next',
    });
  });

  it('DeleteGroupFile：0x6d6_3，签名，busId=102', async () => {
    const nt = makeNative(encode(DeleteGroupFile.respSchema, { delete: { retCode: 0 } }));
    await DeleteGroupFile.invoke(nt, 1, { groupId: 100, fileId: 'f1' });
    const call = nt.calls[0]!;
    expect(call).toMatchObject({ command: 0x6d6, subCommand: 3, isUid: true, needSign: true });
    expect(decode(DeleteGroupFile.reqSchema, call.body)).toEqual({
      delete: { groupUin: 100, busId: 102, fileId: 'f1' },
    });
  });

  it('RenameGroupFile / MoveGroupFile：0x6d6_4/5，不签名', async () => {
    const renameNt = makeNative(encode(RenameGroupFile.respSchema, { rename: { retCode: 0 } }));
    await RenameGroupFile.invoke(renameNt, 1, {
      groupId: 100,
      fileId: 'f1',
      parentDirectory: '/',
      newFileName: 'n.txt',
    });
    const moveNt = makeNative(encode(MoveGroupFile.respSchema, { move: { retCode: 0 } }));
    await MoveGroupFile.invoke(moveNt, 1, {
      groupId: 100,
      fileId: 'f1',
      parentDirectory: '/',
      targetDirectory: 'folder',
    });
    expect([
      [renameNt.calls[0]!.command, renameNt.calls[0]!.subCommand, renameNt.calls[0]!.needSign],
      [moveNt.calls[0]!.command, moveNt.calls[0]!.subCommand, moveNt.calls[0]!.needSign],
    ]).toEqual([
      [0x6d6, 4, false],
      [0x6d6, 5, false],
    ]);
  });

  it('CreateGroupFolder：0x6d7_0，解析 folderInfo', async () => {
    const resp = encode(CreateGroupFolder.respSchema, {
      create: { retCode: 0, folderInfo: { folderId: 'F1', folderName: 'docs' } },
    });
    const nt = makeNative(resp);
    const created = await CreateGroupFolder.invoke(nt, 1, {
      groupId: 100,
      parentId: '/',
      folderName: 'docs',
    });
    expect(nt.calls[0]).toMatchObject({ command: 0x6d7, subCommand: 0, needSign: false });
    expect(created.folderId).toBe('F1');
    expect(created.folderName).toBe('docs');
  });

  it('DeleteGroupFolder / RenameGroupFolder：0x6d7_1/2，不签名', async () => {
    const deleteNt = makeNative(encode(DeleteGroupFolder.respSchema, { delete: { retCode: 0 } }));
    await DeleteGroupFolder.invoke(deleteNt, 1, { groupId: 100, folderId: 'F1' });
    const renameNt = makeNative(encode(RenameGroupFolder.respSchema, { rename: { retCode: 0 } }));
    await RenameGroupFolder.invoke(renameNt, 1, {
      groupId: 100,
      folderId: 'F1',
      newFolderName: 'x',
    });
    expect([
      [deleteNt.calls[0]!.command, deleteNt.calls[0]!.subCommand],
      [renameNt.calls[0]!.command, renameNt.calls[0]!.subCommand],
    ]).toEqual([
      [0x6d7, 1],
      [0x6d7, 2],
    ]);
  });

  it('GetGroupFileCount / Space：0x6d8_2/3，count 带 busId=6', async () => {
    const nt = makeNative();
    await GetGroupFileCount.invoke(nt, 1, { groupId: 100 });
    await GetGroupFileSpace.invoke(nt, 1, { groupId: 100 });
    expect(nt.calls.map((c) => [c.command, c.subCommand, c.needSign])).toEqual([
      [0x6d8, 2, false],
      [0x6d8, 3, false],
    ]);
    expect(decode(GetGroupFileCount.reqSchema, nt.calls[0]!.body)).toEqual({
      count: { groupUin: 100, appId: 7, busId: 6 },
    });
  });

  it('群待办：0xf90 按动作切 subCommand', async () => {
    const nt = makeNative();
    await GroupTodo.invoke(nt, 1, { groupId: 100, msgSeq: 9, action: 'set' });
    await GroupTodo.invoke(nt, 1, { groupId: 100, msgSeq: 9, action: 'complete' });
    await GroupTodo.invoke(nt, 1, { groupId: 100, msgSeq: 9, action: 'cancel' });
    expect(nt.calls.map((c) => c.subCommand)).toEqual([1, 2, 3]);
    expect(nt.calls[0]!.needSign).toBe(false);
  });

  it('GetGroupTodoList：解析 msgId 的 sequence_random 并过滤消失项', async () => {
    const resp = encode(GetGroupTodoList.respSchema, {
      banners: [
        {
          msgId: new TextEncoder().encode('12_34'),
          commonBanner: { ui: { text: 'todo' }, createTime: 5, updateTime: 6 },
        },
        { msgId: new TextEncoder().encode('1_2'), isDisappear: true },
      ],
    });
    const nt = makeNative(resp);
    const list = await GetGroupTodoList.invoke(nt, 1, { groupId: 100 });
    expect(list).toEqual([
      {
        sourceId: '12_34',
        sequence: '12',
        random: 34,
        text: 'todo',
        createdAt: 5,
        updatedAt: 6,
        completed: false,
      },
    ]);
  });

  it('群待办读回的 uint64 序号不经过 Number，越界标识拒绝使用', async () => {
    const reply = (sequence: string) =>
      encode(GetGroupTodoList.respSchema, {
        banners: [{ msgId: new TextEncoder().encode(`${sequence}_1`) }],
      });
    const nt = makeNative(reply('18446744073709551615'));
    expect((await GetGroupTodoList.invoke(nt, 1, { groupId: 100 }))[0]?.sequence).toBe(
      '18446744073709551615',
    );
    await expect(
      GetGroupTodoList.invoke(makeNative(reply('18446744073709551616')), 1, { groupId: 100 }),
    ).rejects.toThrow('uint64');
    expect(() =>
      GroupTodo.serialize({ groupId: 100, msgSeq: 18446744073709551616n, action: 'set' }),
    ).toThrow('uint64');
  });
  it('群待办完成后即使横幅已消失，仍保留服务端的完成状态', async () => {
    const response = encode(GetGroupTodoList.respSchema, {
      banners: [
        {
          msgId: new TextEncoder().encode('12_34'),
          todoBanner: { text: '事项', isComplete: true },
          isDisappear: true,
        },
      ],
    });
    expect(await GetGroupTodoList.invoke(makeNative(response), 1, { groupId: 100 })).toEqual([
      {
        sourceId: '12_34',
        sequence: '12',
        random: 34,
        text: '事项',
        createdAt: 0,
        updatedAt: 0,
        completed: true,
      },
    ]);
  });
  it('SendGroupSign：0xeb7_1，不签名，uin/groupId 都是字符串', async () => {
    const nt = makeNative();
    await SendGroupSign.invoke(nt, 1, { groupId: 100, selfUin: 200 });
    const call = nt.calls[0]!;
    expect(call).toMatchObject({ command: 0xeb7, subCommand: 1, needSign: false });
    expect(decode(SendGroupSign.reqSchema, call.body)).toEqual({
      signInInfo: { uin: '200', groupId: '100', version: '9.0.90' },
    });
  });
});

describe('请求处理 / 状态 / 已读', () => {
  it('SetGroupRequest：0x10c8_1，空理由写空格', async () => {
    const nt = makeNative();
    await SetGroupRequest.invoke(nt, 1, {
      groupId: 100,
      sequence: 7,
      eventType: 2,
      approve: false,
    });
    const call = nt.calls[0]!;
    expect(call).toMatchObject({ command: 0x10c8, subCommand: 1, needSign: true, isUid: true });
    expect(
      (decode(SetGroupRequest.reqSchema, call.body).body as Record<string, unknown>).message,
    ).toBe(' ');
  });

  it('SetGroupRequest：filtered 走 0x10c8_2', async () => {
    const nt = makeNative();
    await SetGroupRequest.invoke(nt, 1, {
      groupId: 100,
      sequence: 7,
      eventType: 2,
      approve: true,
      filtered: true,
    });
    expect(nt.calls[0]!.subCommand).toBe(2);
  });

  it('FetchGroupRequests：0x10c0_1/2，签名', async () => {
    const nt = makeNative();
    await FetchGroupRequests.invoke(nt, 1, {});
    await FetchGroupRequests.invoke(nt, 1, { filtered: true });
    expect(nt.calls.map((c) => [c.command, c.subCommand, c.needSign])).toEqual([
      [0x10c0, 1, true],
      [0x10c0, 2, true],
    ]);
  });

  it('HandleFriendRequest：0xb5d_44，同意 3 / 拒绝 5', async () => {
    const nt = makeNative();
    await HandleFriendRequest.invoke(nt, 1, { targetUid: 'u1', approve: true });
    await HandleFriendRequest.invoke(nt, 1, { targetUid: 'u1', approve: false });
    expect(nt.calls.map((c) => [c.command, c.subCommand, c.needSign])).toEqual([
      [0xb5d, 44, false],
      [0xb5d, 44, false],
    ]);
    expect(decode(HandleFriendRequest.reqSchema, nt.calls[0]!.body).accept).toBe(3);
    expect(decode(HandleFriendRequest.reqSchema, nt.calls[1]!.body).accept).toBe(5);
  });

  it('SetOnlineStatus：走 trpc，不签名', async () => {
    const nt = makePacketNative();
    await SetOnlineStatus.invoke(nt, 1, { status: 30, extStatus: 1028 });
    expect(nt.calls[0]).toMatchObject({
      cmd: 'trpc.qq_new_tech.status_svc.StatusService.SetStatus',
      needSign: false,
    });
    expect(decode(SetOnlineStatus.reqSchema, nt.calls[0]!.body)).toEqual({
      status: 30,
      extStatus: 1028,
      batteryStatus: 100,
    });
  });

  it('SetSelfLongNick：0x112a_2，profile{tag:102}', async () => {
    const nt = makeNative();
    await SetSelfLongNick.invoke(nt, 1, { selfUin: 200, longNick: 'hi' });
    expect(nt.calls[0]).toMatchObject({ command: 0x112a, subCommand: 2, needSign: true });
    expect(decode(SetSelfLongNick.reqSchema, nt.calls[0]!.body)).toEqual({
      uin: 200n,
      profile: { tag: 102, value: 'hi' },
    });
  });

  it('ClickInlineKeyboardButton：0x112e_1，签名', async () => {
    const nt = makeNative();
    await ClickInlineKeyboardButton.invoke(nt, 1, {
      groupId: 100,
      botAppid: 1000,
      buttonId: 'b',
      msgSeq: 9,
    });
    expect(nt.calls[0]).toMatchObject({ command: 0x112e, subCommand: 1, needSign: true });
  });

  it('ReadedReport：SsoReadedReport，签名；单包上限 100', async () => {
    const nt = makePacketNative();
    await ReadedReport.invoke(nt, 1, {
      groups: [{ groupId: 100, lastReadSeq: 5 }],
      c2c: [{ uid: 'u1', lastReadSeq: 6 }],
    });
    expect(nt.calls[0]).toMatchObject({
      cmd: 'trpc.msg.msg_svc.MsgService.SsoReadedReport',
      needSign: true,
    });
    expect(decode(ReadedReport.reqSchema, nt.calls[0]!.body)).toMatchObject({
      groupList: [{ groupUin: 100n, lastReadSeq: 5n }],
      c2cList: [{ uid: 'u1', lastReadSeq: 6n }],
    });
    expect(() =>
      ReadedReport.serialize({
        groups: Array.from({ length: 101 }, (_, i) => ({ groupId: i + 1 })),
      }),
    ).toThrow();
  });

  it('DeleteGroupAlbumMedia：trpc 删除，校验 seq', async () => {
    // 回包必须回显 seq=8694 且 code=0。
    const resp = encode(DeleteGroupAlbumMedia.respSchema, { field1: 8694, field2: 0 });
    const nt = makePacketNative(resp);
    await DeleteGroupAlbumMedia.invoke(nt, 1, {
      groupId: '100',
      albumId: 'a',
      mediaIds: ['l1'],
    });
    expect(nt.calls[0]).toMatchObject({
      cmd: 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias',
      needSign: false,
    });
    const body = decode(DeleteGroupAlbumMedia.reqSchema, nt.calls[0]!.body);
    expect(body.field1).toBe(8694);
    expect((body.body as Record<string, unknown>).mediaIds).toEqual(['l1']);
  });
});
