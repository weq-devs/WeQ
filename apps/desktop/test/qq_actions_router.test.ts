import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readFavoriteEmojiBundle,
  createFavoriteEmojiBundle,
  FavoriteEmojiImportSession,
  type ExportTaskManager,
  type GroupFileListing,
} from '@weq/service';
import {
  PROFILE_LIKE_MAX_PER_REQUEST,
  type GroupJoinInfo,
  type CustomFaceDetail,
  makeSolidPng,
} from '@weq/protocol';
import { createQQActionsRouter, type QQActionServices } from '../src/main/ipc/routers/qq_actions';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
const group = { ...binding, groupId: 123 };
const empty = () => vi.fn(async (..._args: unknown[]) => {});
function fixture() {
  let active = true;
  const record = { qqPid: 101 };
  const s = {
    accountConfig: { getRecord: () => record },
    accountWrite: { selfIdentity: () => ({ uin: '10001', uid: 'u_self' }) },
    groupFile: {
      count: vi.fn(async () => ({ fileCount: 2, maxCount: 10, isFull: false })),
      space: vi.fn(async () => ({ usedSpace: 100, totalSpace: 1000 })),
      deleteFile: empty(),
      renameFile: empty(),
      moveFile: empty(),
      createFolder: empty(),
      deleteFolder: empty(),
      renameFolder: empty(),
      list: vi.fn(
        async (): Promise<GroupFileListing> => ({ targetDirectory: '/', folders: [], files: [] }),
      ),
    },
    groupInfo: {
      listGroupDirectory: vi.fn(async () => [{ groupCode: '123', role: 'admin' }]),
      getJoinInfo: vi.fn(
        async (_groupId: number): Promise<GroupJoinInfo> => ({
          groupId: 888,
          name: '目标群',
          categoryId: 2,
          categoryName: '服务端分类',
          option: 5,
          question: '为什么加入',
          questionState: 'available' as const,
        }),
      ),
    },
    groupModeration: {
      getAtAllRemain: vi.fn(async () => ({
        canAtAll: true,
        remainCountForGroup: 4,
        remainCountForUin: 2,
      })),
      setTodo: empty(),
      getTodoList: vi.fn(async () => []),
      leaveGroup: empty(),
      setAddOption: empty(),
      addCategoryTag: empty(),
      deleteCategoryTag: empty(),
      getCategoryTags: vi.fn(async () => []),
    },
    groupAlbumMedia: { deleteMedia: empty(), setLike: empty(), comment: empty() },
    webQuery: {
      getDaySignedList: vi.fn(async () => []),
      uploadQzoneImage: vi.fn(async () => ({ richval: 'uploaded-richval' })),
      getGroupNotice: vi.fn(async () => []),
      setGroupNotice: empty(),
      deleteGroupNotice: empty(),
      uploadGroupNoticeImage: vi.fn(async () => ({ id: 'pic', width: 1, height: 1 })),
      uploadGroupAlbumImage: empty(),
      setQzoneLike: empty(),
      commentQzone: empty(),
    },
    emoji: {
      fetchOnlineFavoriteIds: vi.fn(async () => [
        '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0',
      ]),
      listFavoriteEmojis: vi.fn(async () => []),
      fetchOnlineFavoriteDetails: vi.fn(async (): Promise<CustomFaceDetail[]> => []),
      listFavEmojiRows: vi.fn(async () => []),
      addFavorite: empty(),
      deleteFavorite: empty(),
      modifyFavoriteDesc: empty(),
      moveFavorite: empty(),
    },
    profile: {
      listBuddyRequests: vi.fn(async () => [
        {
          peerUid: 'u_friend',
          isAccepted: 1,
          initiator: 1,
          status: 3,
          nick: '申请人',
          verifyMsg: '你好',
        },
      ]),
      listDoubtFriendRequests: vi.fn(async () => [
        { uid: 'u_doubt', nick: '可疑申请', message: '你好', reason: '验证' },
      ]),
      handleFriendRequest: empty(),
      approveDoubtFriendRequest: empty(),
      rejectDoubtFriendRequest: empty(),
    },
    groupNotify: {
      fetchOnlineRequests: vi.fn(async () => [
        {
          groupId: 123,
          sequence: 55,
          eventType: 7,
          state: 1,
          filtered: false,
          target: { uid: 'u_friend', uin: 10002, name: '申请人' },
          groupName: '测试群',
          comment: '申请留言',
          operateTransInfo: new Uint8Array([1, 2]),
        },
      ]),
      handleOnlineRequest: empty(),
    },
    fileResource: {
      resolveLocalFile: vi.fn(async (_path: string): Promise<string | null> => null),
    },
    interaction: {
      setInputStatus: empty(),
      clickInlineButton: vi.fn(async (..._args: unknown[]) => ({
        result: 0,
        errMsg: '',
        promptText: '',
      })),
      sendGroupSign: empty(),
      submitGroupJoinRequest: vi.fn(
        async (..._args: unknown[]): Promise<'accepted' | 'unconfirmed'> => 'unconfirmed',
      ),
    },
    onlineStatus: {
      fetchOnlineStatus: vi.fn(async () => ({ status: 10, extStatus: 1018 })),
      editableExtendedStatuses: () => [{ value: 1018, label: '学习中' }],
    },
    messageSend: { sendFile: vi.fn(async (..._args: unknown[]) => ({ ok: false })) },
    peerStats: {
      sendLike: vi.fn(
        async (_uid: string, _count: number): Promise<'accepted' | 'unconfirmed'> => 'accepted',
      ),
    },
    exportManager: {
      startResourceExport: vi.fn(
        async (_options: Parameters<ExportTaskManager['startResourceExport']>[0]) =>
          'resource-favorite',
      ),
    },
    favoriteEmojiImport: undefined as FavoriteEmojiImportSession | undefined,
  };
  const resolve = (b: typeof binding) => {
    if (
      !active ||
      b.expectedAccountUin !== binding.expectedAccountUin ||
      b.expectedAccountConfigId !== binding.expectedAccountConfigId
    )
      throw new Error('账号已切换');
    return s as unknown as QQActionServices;
  };
  const resolveShare = vi.fn(async () => ({
    groupCode: '888',
    authKey: 'synthetic-share-key',
    uin: '10001',
    token: 'opaque-share-data',
    svctype: '5',
    tempid: 'h5_group_info',
  }));
  return {
    s,
    record,
    caller: createQQActionsRouter(resolve, resolveShare).createCaller({}),
    resolveShare,
    switchAccount: () => {
      active = false;
    },
  };
}

describe('收藏包导入路由', () => {
  it('收藏移动接口只接受置前，不把任意位置转成真实写入', async () => {
    const f = fixture();
    const emojiId = '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0';
    await expect(
      f.caller.favorite({ ...binding, action: 'move', emojiId, position: 2 }),
    ).rejects.toThrow();
    expect(f.s.emoji.moveFavorite).not.toHaveBeenCalled();
    expect(
      (await f.caller.favorite({ ...binding, action: 'move', emojiId, position: 1 })).state,
    ).toBe('accepted');
    expect(f.s.emoji.moveFavorite).toHaveBeenCalledWith(emojiId, 1, expect.any(Function));
  });
  it('私有预览携带令牌，离线仍可读取和清理，不触发 QQ 写入', async () => {
    const f = fixture();
    const bytes = Buffer.from(makeSolidPng(2, 3, [10, 20, 30]));
    const md5 = createHash('md5').update(bytes).digest('hex');
    const archive = await createFavoriteEmojiBundle(
      [{ emojiId: `10001_0_0_0_${md5}_0_0`, md5, description: '备注', position: 1 }],
      async () => bytes,
    );
    const manager = new FavoriteEmojiImportSession(
      { ...f.s.emoji, addFavorite: async () => '' },
      { trustPath: vi.fn(), untrustPath: vi.fn() },
    );
    f.s.favoriteEmojiImport = manager;
    const directory = await mkdtemp(join(tmpdir(), 'weq-import-router-'));
    const path = join(directory, 'synthetic.zip');
    try {
      await writeFile(path, archive.archive);
      await expect(f.caller.favoriteImportPreview({ ...binding, path })).rejects.toThrow('未授权');
      f.s.fileResource.resolveLocalFile.mockResolvedValue(path);
      const view = await f.caller.favoriteImportPreview({ ...binding, path });
      expect(view.items[0]).toMatchObject({ disposition: 'ready', description: '备注' });
      expect(JSON.stringify(view)).not.toContain('bytes');
      const offlineResolve = vi.fn(() => {
        throw new Error('QQ 离线');
      });
      const offline = createQQActionsRouter(
        offlineResolve,
        undefined,
        () => f.s as unknown as QQActionServices,
      ).createCaller({});
      expect((await offline.favoriteImportState(binding))?.token).toBe(view.token);
      expect(await offline.favoriteImportDiscard({ ...binding, token: view.token })).toEqual({
        discarded: true,
      });
      await expect(stat(view.items[0]!.previewPath!)).rejects.toThrow();
      expect(offlineResolve).not.toHaveBeenCalled();
      expect(f.s.emoji.addFavorite).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('批量导入占用现有 QQ 写锁直到在途请求结束，取消不释放过早', async () => {
    const f = fixture();
    const bytes = Buffer.from(makeSolidPng(2, 3, [40, 50, 60]));
    const md5 = createHash('md5').update(bytes).digest('hex');
    const emojiId = `10001_0_0_0_${md5}_0_0`;
    const archive = await createFavoriteEmojiBundle(
      [{ emojiId, md5, description: '备注', position: 1 }],
      async () => bytes,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.s.emoji.fetchOnlineFavoriteIds.mockResolvedValue([]);
    const add = vi.fn(
      async (_bytes: Uint8Array, _log?: (message: string) => void, beforeSend?: () => void) => {
        beforeSend?.();
        await gate;
        return emojiId;
      },
    );
    const manager = new FavoriteEmojiImportSession(
      { ...f.s.emoji, addFavorite: add },
      { trustPath: vi.fn(), untrustPath: vi.fn() },
    );
    f.s.favoriteEmojiImport = manager;
    try {
      const view = await manager.prepare(archive.archive, () => {});
      await f.caller.favoriteImportStart({
        ...binding,
        token: view.token,
        keys: [view.items[0]!.key],
      });
      await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
      await expect(f.caller.favorite({ ...binding, action: 'delete', emojiId })).rejects.toThrow(
        '等待',
      );
      await f.caller.favoriteImportCancel({ ...binding, token: view.token });
      await expect(f.caller.favorite({ ...binding, action: 'delete', emojiId })).rejects.toThrow(
        '等待',
      );
      release();
      await vi.waitFor(() => expect(manager.read()?.phase).toBe('finished'));
      expect((await f.caller.favorite({ ...binding, action: 'delete', emojiId })).state).toBe(
        'accepted',
      );
      expect(add).toHaveBeenCalledOnce();
      expect(f.s.emoji.modifyFavoriteDesc).not.toHaveBeenCalled();
    } finally {
      release();
      await manager.dispose();
    }
  });
});

describe('收藏包导出任务', () => {
  it('保存位置未准备时不入队，稍后保存沿用单文件 ZIP 任务', async () => {
    const f = fixture();
    await expect(
      f.caller.favoriteExport({ ...binding, savePolicy: { mode: 'before' } }),
    ).rejects.toThrow('位置');
    expect(f.s.exportManager.startResourceExport).not.toHaveBeenCalled();
    expect(await f.caller.favoriteExport({ ...binding, savePolicy: { mode: 'after' } })).toBe(
      'resource-favorite',
    );
    expect(f.s.exportManager.startResourceExport.mock.calls[0]?.[0]).toMatchObject({
      kind: 'favorite-emoji',
      output: { kind: 'file', extension: 'zip' },
      savePolicy: { mode: 'after' },
    });
  });
  it('缺原图仍写出可核对的包，失败数量供公共任务列表展示', async () => {
    const f = fixture();
    const emojiId = (await f.s.emoji.fetchOnlineFavoriteIds())[0]!;
    f.s.emoji.fetchOnlineFavoriteDetails.mockResolvedValue([{ emojiId, desc: '合成备注' }]);
    await f.caller.favoriteExport({ ...binding, savePolicy: { mode: 'after' } });
    const run = f.s.exportManager.startResourceExport.mock.calls[0]![0].run;
    const directory = await mkdtemp(join(tmpdir(), 'weq-favorite-export-'));
    try {
      const result = await run({
        directory,
        signal: new AbortController().signal,
        progress: vi.fn(),
      });
      expect(result).toMatchObject({
        total: 1,
        ok: 1,
        failed: [],
        fileName: 'favorite-emoji.zip',
        contents: { total: 1, ok: 0, failed: [{ fileName: '1. 合成备注', error: '无法读取原图' }] },
      });
      expect(
        readFavoriteEmojiBundle(await readFile(join(directory, result.fileName!)))[0],
      ).toMatchObject({ description: '合成备注', image: null });
      expect(f.s.emoji.addFavorite).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('排队后 QQ PID 改变时不再导出旧账号资源', async () => {
    const f = fixture();
    await f.caller.favoriteExport({ ...binding, savePolicy: { mode: 'after' } });
    f.record.qqPid++;
    const run = f.s.exportManager.startResourceExport.mock.calls[0]![0].run;
    await expect(
      run({ directory: '/unused', signal: new AbortController().signal, progress: vi.fn() }),
    ).rejects.toThrow('运行时');
    expect(f.s.emoji.fetchOnlineFavoriteIds).not.toHaveBeenCalled();
    expect(f.s.emoji.addFavorite).not.toHaveBeenCalled();
  });
});

describe('加群方式读回', () => {
  it('复用现有在线资料查询，读取方式与问题但不伪造答案', async () => {
    const f = fixture();
    const result = await f.caller.groupJoinSettings({ ...binding, groupId: 888 });
    expect(f.s.groupInfo.getJoinInfo).toHaveBeenCalledWith(888);
    expect(result).toMatchObject({ option: 5, question: '为什么加入' });
    expect(result).not.toHaveProperty('answer');
    expect(f.s.groupModeration.setAddOption).not.toHaveBeenCalled();
  });
  it('分类标签写入前核对真实群分类，缺失、变化或读取后切源都不写入', async () => {
    const f = fixture();
    const input = { ...binding, groupId: 123, action: 'addTag' as const, category: 2, tag: '合成' };
    const info = {
      groupId: 123,
      name: '目标群',
      categoryId: 2,
      categoryName: '服务端分类',
      option: 2,
      question: '',
      questionState: 'not-required' as const,
    };
    f.s.groupInfo.getJoinInfo.mockResolvedValue(info);
    await expect(f.caller.groupSettings(input)).resolves.toEqual({ state: 'accepted' });
    expect(f.s.groupModeration.addCategoryTag).toHaveBeenCalledWith(2, '合成');
    for (const snapshot of [
      { ...info, categoryId: null },
      { ...info, categoryId: 3 },
      { ...info, groupId: 999 },
    ]) {
      f.s.groupInfo.getJoinInfo.mockResolvedValueOnce(snapshot);
      await expect(f.caller.groupSettings(input)).rejects.toThrow('分类');
    }
    f.s.groupInfo.getJoinInfo.mockImplementationOnce(async () => {
      f.switchAccount();
      return info;
    });
    await expect(f.caller.groupSettings(input)).rejects.toThrow('账号已切换');
    expect(f.s.groupModeration.addCategoryTag).toHaveBeenCalledTimes(1);
  });
});

describe('主动操作的账号与参数边界', () => {
  it('资料卡点赞校验 UID、次数和本人，未知回执不升级为成功', async () => {
    const f = fixture();
    const input = { ...binding, uid: 'u_friend', count: 1 };
    await expect(f.caller.profileLike(input)).resolves.toEqual({ state: 'accepted' });
    expect(f.s.peerStats.sendLike).toHaveBeenCalledWith('u_friend', 1);
    f.s.peerStats.sendLike.mockResolvedValueOnce('unconfirmed');
    await expect(f.caller.profileLike(input)).resolves.toEqual({ state: 'unconfirmed' });
    for (const count of [0, -1, 1.5, PROFILE_LIKE_MAX_PER_REQUEST + 1])
      await expect(f.caller.profileLike({ ...input, count })).rejects.toThrow();
    await expect(f.caller.profileLike({ ...input, uid: '10002' })).rejects.toThrow();
    await expect(f.caller.profileLike({ ...input, uid: 'u_self' })).rejects.toThrow('自己');
    expect(f.s.peerStats.sendLike).toHaveBeenCalledTimes(2);
    f.s.peerStats.sendLike.mockRejectedValueOnce(new Error('今日次数限制'));
    await expect(f.caller.profileLike(input)).rejects.toThrow('今日次数限制');
    f.switchAccount();
    await expect(f.caller.profileLike(input)).rejects.toThrow('账号已切换');
    expect(f.s.peerStats.sendLike).toHaveBeenCalledTimes(3);
  });
  it('资料卡点赞在途拒绝重复提交，不自动重试', async () => {
    const f = fixture();
    let finish!: (state: 'accepted') => void;
    f.s.peerStats.sendLike.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const input = { ...binding, uid: 'u_friend', count: 1 };
    const pending = f.caller.profileLike(input);
    await vi.waitFor(() => expect(f.s.peerStats.sendLike).toHaveBeenCalledOnce());
    await expect(f.caller.profileLike(input)).rejects.toThrow('等待');
    finish('accepted');
    await expect(pending).resolves.toEqual({ state: 'accepted' });
    expect(f.s.peerStats.sendLike).toHaveBeenCalledOnce();
  });
  it('普通成员可打卡，路由只用当前绑定目标，原生失败不上报受理', async () => {
    const f = fixture();
    f.s.groupInfo.listGroupDirectory.mockResolvedValue([{ groupCode: '123', role: 'member' }]);
    await expect(f.caller.groupSettings({ ...group, action: 'sign' })).resolves.toEqual({
      state: 'accepted',
    });
    expect(f.s.interaction.sendGroupSign).toHaveBeenCalledWith(123);
    f.s.interaction.sendGroupSign.mockRejectedValueOnce(new Error('打卡被拒绝'));
    await expect(f.caller.groupSettings({ ...group, action: 'sign' })).rejects.toThrow(
      '打卡被拒绝',
    );
    f.switchAccount();
    await expect(f.caller.groupSettings({ ...group, action: 'sign' })).rejects.toThrow(
      '账号已切换',
    );
    expect(f.s.interaction.sendGroupSign).toHaveBeenCalledTimes(2);
  });
  it('普通成员只能管理自己上传的文件，不能管理目录或设置群待办', async () => {
    const f = fixture();
    f.s.groupInfo.listGroupDirectory.mockResolvedValue([{ groupCode: '123', role: 'member' }]);
    const file = {
      fileId: 'own',
      fileName: '文件',
      fileSize: 1,
      busId: 102,
      uploadedTime: 0,
      expireTime: 0,
      modifiedTime: 0,
      downloadedTimes: 0,
      uploaderUin: 10001,
      uploaderName: '自己',
      parentDirectory: '/',
    };
    f.s.groupFile.list.mockResolvedValue({
      targetDirectory: '/',
      folders: [],
      files: [file, { ...file, fileId: 'other', uploaderUin: 10002 }],
    });
    await expect(f.caller.file({ ...group, action: 'delete', id: 'own' })).resolves.toEqual({
      state: 'accepted',
    });
    await expect(
      f.caller.file({ ...group, action: 'rename', id: 'other', name: '新名称' }),
    ).rejects.toThrow(/自己/);
    await expect(f.caller.file({ ...group, action: 'delete', id: 'missing' })).rejects.toThrow(
      /自己|不存在/,
    );
    await expect(f.caller.file({ ...group, action: 'createFolder', name: '目录' })).rejects.toThrow(
      /管理员/,
    );
    await expect(f.caller.todo({ ...group, sequence: '123', action: 'set' })).rejects.toThrow(
      /管理员/,
    );
    await expect(f.caller.todo({ ...group, sequence: '123', action: 'cancel' })).rejects.toThrow(
      /管理员/,
    );
    await expect(f.caller.todo({ ...group, sequence: '123', action: 'complete' })).resolves.toEqual(
      { state: 'accepted' },
    );
    expect(f.s.groupFile.deleteFile).toHaveBeenCalledTimes(1);
    expect(f.s.groupFile.renameFile).not.toHaveBeenCalled();
  });
  it('核对文件归属期间切号不提交，管理员管理文件无需额外扫描目录', async () => {
    const f = fixture();
    await f.caller.file({ ...group, action: 'delete', id: 'file-a' });
    expect(f.s.groupFile.list).not.toHaveBeenCalled();
    f.s.groupInfo.listGroupDirectory.mockResolvedValue([{ groupCode: '123', role: 'member' }]);
    f.s.groupFile.list.mockImplementation(async () => {
      f.switchAccount();
      return { targetDirectory: '/', folders: [], files: [] };
    });
    await expect(f.caller.file({ ...group, action: 'delete', id: 'file-a' })).rejects.toThrow(
      /切换|改变/,
    );
    expect(f.s.groupFile.deleteFile).toHaveBeenCalledTimes(1);
  });
  it('通用加群不向界面泄露鉴权串，必须按读到的目标提交回答', async () => {
    const f = fixture();
    const target = await f.caller.prepareJoin({
      ...binding,
      share: 'https://qm.qq.com/q/synthetic',
    });
    expect(target.groupId).toBe(888);
    expect(target.question).toBe('为什么加入');
    expect(JSON.stringify(target)).not.toContain('synthetic-share-key');
    await expect(
      f.caller.join({ ...binding, groupId: 888, token: target.token, answer: '' }),
    ).rejects.toThrow('回答');
    await expect(
      f.caller.join({ ...binding, groupId: 889, token: target.token, answer: '回答' }),
    ).rejects.toThrow('目标');
    await expect(
      f.caller.join({ ...binding, groupId: 888, token: target.token, answer: '我的回答' }),
    ).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.s.interaction.submitGroupJoinRequest).toHaveBeenCalledWith({
      groupCode: 888,
      authKey: 'synthetic-share-key',
      answer: '我的回答',
    });
    await expect(
      f.caller.join({ ...binding, groupId: 888, token: target.token, answer: '重复提交' }),
    ).rejects.toThrow('过期');
  });
  it('拒绝非 QQ 链接、过期目标以及分享目标漂移', async () => {
    const f = fixture();
    await expect(
      f.caller.prepareJoin({ ...binding, share: 'https://127.0.0.1/private' }),
    ).rejects.toThrow('分享链接');
    expect(f.resolveShare).not.toHaveBeenCalled();
    const target = await f.caller.prepareJoin({
      ...binding,
      share: 'https://qm.qq.com/q/synthetic',
    });
    f.resolveShare.mockResolvedValueOnce({
      groupCode: '999',
      authKey: 'synthetic',
      uin: '10001',
      token: '',
      svctype: '5',
      tempid: 'h5_group_info',
    });
    await expect(
      f.caller.join({ ...binding, groupId: 888, token: target.token, answer: '回答' }),
    ).rejects.toThrow('变化');
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121000);
    try {
      await expect(
        f.caller.join({ ...binding, groupId: 888, token: target.token, answer: '回答' }),
      ).rejects.toThrow('过期');
    } finally {
      now.mockRestore();
    }
    expect(f.s.interaction.submitGroupJoinRequest).not.toHaveBeenCalled();
  });
  it('问题读取失败保留 unavailable，不伪造无需回答', async () => {
    const f = fixture();
    f.s.groupInfo.getJoinInfo.mockRejectedValueOnce(new Error('拒绝读取'));
    const target = await f.caller.prepareJoin({
      ...binding,
      share: 'https://qm.qq.com/q/synthetic',
    });
    expect(target.questionState).toBe('unavailable');
    expect(target.question).toBeNull();
  });
  it('文件上传固定当前目录，发布结果不明时不报已受理', async () => {
    const f = fixture();
    f.s.fileResource.resolveLocalFile.mockResolvedValueOnce('/selected-file.txt');
    await expect(
      f.caller.fileUpload({ ...group, directory: 'folder-a', path: '/selected-file.txt' }),
    ).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.s.messageSend.sendFile).toHaveBeenCalledWith({
      peerType: 'group',
      targetId: 123,
      path: '/selected-file.txt',
      folderId: 'folder-a',
      beforeSend: expect.any(Function),
    });
    const summary = await f.caller.fileSummary(group);
    expect(summary).toMatchObject({ fileCount: 2, maxCount: 10, usedSpace: 100, totalSpace: 1000 });
  });
  it('公告附加选项按 QQ 的反向语义编码', async () => {
    const f = fixture();
    await f.caller.notice({
      ...group,
      action: 'publish',
      content: '公告',
      popup: true,
      editCardGuide: false,
    });
    expect(f.s.webQuery.setGroupNotice).toHaveBeenCalledWith(
      '123',
      '公告',
      expect.objectContaining({ tipWindowType: 0, isShowEditCard: 1 }),
      expect.any(Function),
    );
  });
  it('群只读辅助项绑定本人并支持打卡翻页', async () => {
    const f = fixture();
    const result = await f.caller.groupReadTools({ ...group, day: '20261019', offset: 100 });
    expect(f.s.groupModeration.getAtAllRemain).toHaveBeenCalledWith(123, '10001');
    expect(f.s.webQuery.getDaySignedList).toHaveBeenCalledWith('123', {
      dayYmd: '20261019',
      offset: 100,
      limit: 100,
    });
    expect(result.atAll.remainCountForUin).toBe(2);
  });
  it('全体候选只读取当前账号额度，不顺带读取打卡或写消息', async () => {
    const f = fixture();
    expect(await f.caller.atAllMention(group)).toMatchObject({
      canManage: true,
      role: 'admin',
      quota: { remainCountForUin: 2, remainCountForGroup: 4 },
    });
    expect(f.s.groupModeration.getAtAllRemain).toHaveBeenCalledWith(123, '10001');
    expect(f.s.webQuery.getDaySignedList).not.toHaveBeenCalled();
    f.s.groupInfo.listGroupDirectory.mockResolvedValue([{ groupCode: '123', role: 'member' }]);
    f.s.groupModeration.getAtAllRemain.mockClear();
    expect(await f.caller.atAllMention(group)).toMatchObject({ canManage: false, quota: null });
    expect(f.s.groupModeration.getAtAllRemain).not.toHaveBeenCalled();
  });
  it('全体额度读取期间切号拒绝旧回包，不把读取错误当成额度为零', async () => {
    const f = fixture();
    f.s.groupModeration.getAtAllRemain.mockImplementationOnce(async () => {
      f.switchAccount();
      return { canAtAll: true, remainCountForUin: 2, remainCountForGroup: 4 };
    });
    await expect(f.caller.atAllMention(group)).rejects.toThrow();
    const failure = fixture();
    failure.s.groupModeration.getAtAllRemain.mockRejectedValueOnce(new Error('quota unavailable'));
    await expect(failure.caller.atAllMention(group)).rejects.toThrow('quota unavailable');
  });
  it('带图评论先上传再使用 richval，取图期间切号不发送评论', async () => {
    const f = fixture();
    const dir = await mkdtemp(join(tmpdir(), 'weq-qzone-comment-test-'));
    const path = join(dir, 'image.png');
    try {
      await writeFile(path, new Uint8Array([1, 2, 3]));
      f.s.fileResource.resolveLocalFile.mockResolvedValue(path);
      await f.caller.qzone({
        ...binding,
        hostUin: '10002',
        tid: 'post-a',
        action: 'comment',
        content: '带图',
        imagePath: path,
      });
      expect(f.s.webQuery.uploadQzoneImage).toHaveBeenCalledWith('AQID', expect.any(Function));
      expect(f.s.webQuery.commentQzone).toHaveBeenCalledWith(
        '10002',
        'post-a',
        '带图',
        1,
        'uploaded-richval',
        expect.any(Function),
      );
      f.s.webQuery.commentQzone.mockClear();
      f.s.webQuery.uploadQzoneImage.mockImplementationOnce(async () => {
        f.switchAccount();
        return { richval: 'old-account-image' };
      });
      await expect(
        f.caller.qzone({
          ...binding,
          hostUin: '10002',
          tid: 'post-a',
          action: 'comment',
          content: '不发送',
          imagePath: path,
        }),
      ).rejects.toThrow('账号');
      expect(f.s.webQuery.commentQzone).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('文件操作固定群、目录和标识，不允许根目录删除或越界群号', async () => {
    const f = fixture();
    await f.caller.file({
      ...group,
      action: 'move',
      id: 'file-a',
      directory: 'folder-a',
      destination: 'folder-b',
    });
    expect(f.s.groupFile.moveFile).toHaveBeenCalledWith(123, 'file-a', 'folder-a', 'folder-b');
    await expect(f.caller.file({ ...group, action: 'deleteFolder', id: '/' })).rejects.toThrow(
      '根目录',
    );
    await expect(
      f.caller.file({ ...group, groupId: 0x100000000, action: 'delete', id: 'file-a' }),
    ).rejects.toThrow();
    await expect(
      f.caller.file({ ...group, expectedAccountConfigId: 'other', action: 'delete', id: 'file-a' }),
    ).rejects.toThrow('账号');
    expect(f.s.groupFile.deleteFile).not.toHaveBeenCalled();
  });
  it('待办保留完整 uint64，拒绝溢出与空序号', async () => {
    const f = fixture();
    await f.caller.todo({ ...group, sequence: '18446744073709551615', action: 'set' });
    expect(f.s.groupModeration.setTodo).toHaveBeenCalledWith(123, 0xffffffffffffffffn, 'set');
    await expect(
      f.caller.todo({ ...group, sequence: '18446744073709551616', action: 'set' }),
    ).rejects.toThrow();
    await expect(f.caller.todo({ ...group, sequence: '0', action: 'set' })).rejects.toThrow();
  });
  it('非管理员不能发布公告，权限读取期间切换账号也不发送', async () => {
    const f = fixture();
    f.s.groupInfo.listGroupDirectory.mockResolvedValueOnce([{ groupCode: '123', role: 'member' }]);
    await expect(f.caller.notice({ ...group, action: 'publish', content: '公告' })).rejects.toThrow(
      '权限',
    );
    f.s.groupInfo.listGroupDirectory.mockImplementationOnce(async () => {
      f.switchAccount();
      return [{ groupCode: '123', role: 'admin' }];
    });
    await expect(f.caller.notice({ ...group, action: 'publish', content: '公告' })).rejects.toThrow(
      '账号',
    );
    expect(f.s.webQuery.setGroupNotice).not.toHaveBeenCalled();
  });
  it('请求正在执行时不并发重放，已发送操作结束时切号不改成失败', async () => {
    const f = fixture();
    let finish = () => {};
    f.s.groupFile.deleteFile.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const pending = f.caller.file({ ...group, action: 'delete', id: 'file-a' });
    await vi.waitFor(() => expect(f.s.groupFile.deleteFile).toHaveBeenCalledOnce());
    await expect(f.caller.file({ ...group, action: 'delete', id: 'file-b' })).rejects.toThrow(
      '等待',
    );
    f.switchAccount();
    finish();
    await expect(pending).resolves.toEqual({ state: 'accepted' });
  });
  it('群申请只透出不透明 token，不能伪造或重复使用', async () => {
    const f = fixture();
    const [r] = await f.caller.requests({ ...binding, kind: 'group' });
    expect(r).not.toHaveProperty('operateTransInfo');
    await expect(
      f.caller.request({ ...binding, kind: 'group', token: 'forged', approve: true }),
    ).rejects.toThrow('过期');
    await f.caller.request({ ...binding, kind: 'group', token: r!.token, approve: true });
    expect(f.s.groupNotify.handleOnlineRequest).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 55, operateTransInfo: new Uint8Array([1, 2]) }),
      true,
      '',
    );
    await expect(
      f.caller.request({ ...binding, kind: 'group', token: r!.token, approve: true }),
    ).rejects.toThrow('过期');
  });
  it('申请列表排除退群通知与自己发出的加群申请，并返回卡片匹配标识', async () => {
    const f = fixture();
    const [incoming] = await f.s.groupNotify.fetchOnlineRequests();
    f.s.groupNotify.fetchOnlineRequests.mockResolvedValueOnce([
      incoming!,
      { ...incoming!, eventType: 13 },
      { ...incoming!, eventType: 1 },
      { ...incoming!, state: 2 },
      { ...incoming!, state: 3 },
      { ...incoming!, target: { uid: '', uin: 0, name: '身份缺失' } },
      { ...incoming!, target: { uid: 'u_self', uin: 10001, name: '自己' } },
    ]);
    const rows = await f.caller.requests({ ...binding, kind: 'group' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uid: 'u_friend', uin: '10002', groupId: '123' });
  });
  it.each(['group', 'filteredGroup'] as const)(
    '%s 保留 UID 或 QQ 号可识别的待处理申请',
    async (kind) => {
      const f = fixture();
      const [incoming] = await f.s.groupNotify.fetchOnlineRequests();
      f.s.accountWrite.selfIdentity = () => ({ uin: '10001', uid: '' });
      f.s.groupNotify.fetchOnlineRequests.mockResolvedValueOnce([
        { ...incoming!, target: { uid: '', uin: 10002, name: 'QQ 申请人' } },
        { ...incoming!, target: { uid: 'u_peer', uin: 0, name: 'UID 申请人' } },
        { ...incoming!, target: { uid: '', uin: 10001, name: '自己' } },
      ]);
      const rows = await f.caller.requests({ ...binding, kind });
      expect(rows).toHaveLength(2);
      expect(rows.map(({ uid, uin }) => ({ uid, uin }))).toEqual([
        { uid: '', uin: '10002' },
        { uid: 'u_peer', uin: '' },
      ]);
    },
  );
  it('好友和可疑申请先核对当前列表，不接受任意 UID', async () => {
    const f = fixture();
    await expect(
      f.caller.request({ ...binding, kind: 'friend', token: 'u_missing', approve: true }),
    ).rejects.toThrow('变化');
    expect(f.s.profile.handleFriendRequest).not.toHaveBeenCalled();
    await f.caller.request({ ...binding, kind: 'doubtFriend', token: 'u_doubt', approve: false });
    expect(f.s.profile.rejectDoubtFriendRequest).toHaveBeenCalledWith('u_doubt');
  });
  it('已同意与自己发出的好友申请既不列为可处理，也不能直接调用审批', async () => {
    const f = fixture();
    const [pending] = await f.s.profile.listBuddyRequests();
    f.s.profile.listBuddyRequests.mockResolvedValue([
      pending!,
      { ...pending!, peerUid: 'u_accepted', isAccepted: 0 },
      { ...pending!, peerUid: 'u_outgoing', initiator: 0 },
    ]);
    const rows = await f.caller.requests({ ...binding, kind: 'friend' });
    expect(rows.map((row) => row.token)).toEqual(['u_friend']);
    for (const token of ['u_accepted', 'u_outgoing']) {
      await expect(
        f.caller.request({ ...binding, kind: 'friend', token, approve: true }),
      ).rejects.toThrow('变化');
    }
    expect(f.s.profile.handleFriendRequest).not.toHaveBeenCalled();
    await f.caller.request({ ...binding, kind: 'friend', token: 'u_friend', approve: true });
    expect(f.s.profile.handleFriendRequest).toHaveBeenCalledWith('u_friend', true);
  });
  it('未知输入事件不会发包，内联按钮保留原始定位', async () => {
    const f = fixture();
    await f.caller.inputStatus({ ...binding, uid: 'u_friend', eventType: 1 });
    expect(f.s.interaction.setInputStatus).toHaveBeenCalledTimes(1);
    expect(f.s.interaction.setInputStatus).toHaveBeenCalledWith('u_friend', 1);
    await expect(
      f.caller.inputStatus({ ...binding, uid: 'u_friend', eventType: 0 as 1 }),
    ).rejects.toThrow();
    expect(f.s.interaction.setInputStatus).toHaveBeenCalledTimes(1);
    await f.caller.inlineButton({
      ...group,
      botAppid: '10001',
      buttonId: 'button-a',
      sequence: '500',
      callbackData: 'payload',
    });
    expect(f.s.interaction.clickInlineButton).toHaveBeenCalledWith({
      groupId: 123,
      botAppid: '10001',
      buttonId: 'button-a',
      msgSeq: '500',
      callbackData: 'payload',
    });
    f.s.interaction.clickInlineButton.mockResolvedValueOnce({
      result: 1,
      errMsg: '机器人拒绝',
      promptText: '',
    });
    await expect(
      f.caller.inlineButton({ ...group, botAppid: '10001', buttonId: 'button-a', sequence: '500' }),
    ).rejects.toThrow('机器人拒绝');
    await expect(
      f.caller.inlineButton({
        ...group,
        botAppid: '10001',
        buttonId: 'button-a',
        sequence: '18446744073709551616',
      }),
    ).rejects.toThrow();
    await expect(
      f.caller.inlineButton({
        ...group,
        botAppid: '10001',
        buttonId: 'button-a',
        sequence: 'invalid',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('图片必须经文件选择授权，读取期间运行时变化会阻止上传', async () => {
    const f = fixture();
    await expect(
      f.caller.favorite({ ...binding, action: 'add', path: '/not-authorized.png' }),
    ).rejects.toThrow('未授权');
    const dir = await mkdtemp(join(tmpdir(), 'weq-action-test-'));
    const path = join(dir, 'image.png');
    try {
      await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'));
      f.s.fileResource.resolveLocalFile.mockImplementationOnce(async () => {
        f.record.qqPid = 102;
        return path;
      });
      await expect(f.caller.favorite({ ...binding, action: 'add', path })).rejects.toThrow(
        '运行时',
      );
      expect(f.s.emoji.addFavorite).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('相册评论传递主进程身份和下一阶段校验回调', async () => {
    const f = fixture();
    await f.caller.albumMedia({
      ...group,
      albumId: 'album-a',
      mediaId: 'media-a',
      batchId: '42',
      action: 'comment',
      content: '测试评论',
    });
    expect(f.s.groupAlbumMedia.comment).toHaveBeenCalledWith(
      '123',
      'album-a',
      '42',
      'media-a',
      '10001',
      '测试评论',
      expect.any(Function),
    );
    const guard = f.s.groupAlbumMedia.comment.mock.calls[0]![6] as () => void;
    f.record.qqPid = 102;
    expect(guard).toThrow('运行时');
  });
});
