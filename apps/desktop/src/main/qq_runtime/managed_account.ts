import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withResourceRoots, type Platform } from '@weq/platform';
import type { DatabaseAlgorithms } from '@weq/native';

/** 仅在主进程内传递，密钥和设备信息不能进入运行时公开快照。 */
export interface ManagedQQAccountSource {
  instanceId: string;
  pid: number;
  uin: string;
  uid: string;
  guid: string;
  dataRoot: string;
  dbPath: string;
  dbKey: string;
  algo: DatabaseAlgorithms;
  wrapperPath: string;
  majorPath: string;
  version: string;
  signal: AbortSignal;
  isSsoReady(): boolean;
}

/** 只重定向已验证的托管账号；进程来自监督器，不放宽系统 QQ 的进程名过滤。 */
export function managedAccountPlatform(
  base: Platform,
  initial: ManagedQQAccountSource,
  current: () => ManagedQQAccountSource | null,
): Platform {
  const dbDir = dirname(initial.dbPath),
    accountDir = dirname(dbDir),
    ntData = join(accountDir, 'nt_data');
  const media = {
    accountDir,
    ntDataDir: ntData,
    picDir: join(ntData, 'Pic'),
    pttDir: join(ntData, 'Ptt'),
    videoDir: join(ntData, 'Video'),
    fileDir: join(ntData, 'File'),
    emojiResourceDir: join(ntData, 'Emoji', 'BaseEmojiSyastems', 'EmojiSystermResource'),
    marketFaceDir: join(ntData, 'Emoji', 'marketface'),
    emojiRecvDir: join(ntData, 'Emoji', 'emoji-recv'),
    personalEmojiDir: join(ntData, 'Emoji', 'personal_emoji'),
    emojiRelatedDir: join(ntData, 'Emoji', 'emoji-related', 'emoji'),
  };
  const resource = withResourceRoots(base, () => ({
    dbDir,
    media: Object.fromEntries(
      Object.entries(media).map(([key, path]) => [key, existsSync(path) ? path : null]),
    ),
  }));
  const wrapped = { ...base };
  const source = () => {
    const value = current();
    return value?.uin === initial.uin &&
      value.uid === initial.uid &&
      value.dbPath === initial.dbPath
      ? value
      : null;
  };
  const ownPid = () => {
    const value = source();
    return value && !value.signal.aborted && value.isSsoReady() ? value.pid : null;
  };
  for (const key of [
    'accountDir',
    'ntDbDir',
    'ntDataDir',
    'picDir',
    'pttDir',
    'videoDir',
    'fileDir',
    'emojiResourceDir',
    'marketFaceDir',
    'emojiRecvDir',
    'personalEmojiDir',
    'emojiRelatedDir',
    'groupInfoDbPath',
    'profileInfoDbPath',
    'miscDbPath',
    'buddyMsgFtsDbPath',
    'groupMsgFtsDbPath',
  ] as const) {
    wrapped[key] = (uin) => (uin === initial.uin ? resource[key](uin) : base[key](uin));
  }
  wrapped.ntMsgDbPath = (uin) =>
    uin === initial.uin
      ? existsSync(initial.dbPath)
        ? initial.dbPath
        : null
      : base.ntMsgDbPath(uin);
  wrapped.qqDataRoot = () => initial.dataRoot;
  wrapped.jiebaDictDir = () => {
    const path = join(initial.dataRoot, 'global', 'nt_data', 'search', 'resource_jieba');
    return existsSync(path) ? path : null;
  };
  wrapped.resolveQqPid = (uin) => (uin === initial.uin ? ownPid() : base.resolveQqPid(uin));
  wrapped.resolveQqPidAsync = async (uin) =>
    uin === initial.uin
      ? ownPid()
      : base.resolveQqPidAsync
        ? base.resolveQqPidAsync(uin)
        : base.resolveQqPid(uin);
  wrapped.isQqLoggedIn = (uin) =>
    uin === initial.uin ? ownPid() !== null : base.isQqLoggedIn(uin);
  wrapped.qqWrapperNodePath = (pid) =>
    pid === undefined || pid === source()?.pid ? initial.wrapperPath : base.qqWrapperNodePath(pid);
  wrapped.qqMajorNodePath = (pid) =>
    pid === undefined || pid === source()?.pid ? initial.majorPath : base.qqMajorNodePath(pid);
  wrapped.qqVersion = () => initial.version;
  return wrapped;
}
