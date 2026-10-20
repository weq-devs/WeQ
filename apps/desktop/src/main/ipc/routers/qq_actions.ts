import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { parseCustomFaceId, type GroupRequest } from '@weq/protocol';
import { isIncomingPendingBuddyRequest } from '@weq/service/buddy-request';
import {
  parseGroupShareLocation,
  resolveGroupShareAuthKey,
  type GroupShareTarget,
} from '@weq/service/qq-group-join';
import type { AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import type { QQWriteBinding } from './qq_write';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
const text = z.string().trim().min(1).max(4096);
const id = z.string().min(1).max(1024);
const groupId = z.number().int().positive().max(0xffffffff);
const group = binding.extend({ groupId });
const sequence = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine(
    (value) => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn,
    '消息序号超出 uint64 范围',
  );
const uid = z.string().regex(/^u_[A-Za-z0-9_-]+$/);
const album = group.extend({ albumId: id });
const media = album.extend({ mediaId: id, batchId: z.string().regex(/^\d+$/) });
const accepted = { state: 'accepted' as const };
export type QQActionServices = Pick<
  AccountServices,
  | 'accountWrite'
  | 'accountConfig'
  | 'groupFile'
  | 'groupAlbumMedia'
  | 'groupModeration'
  | 'groupNotify'
  | 'groupInfo'
  | 'profile'
  | 'interaction'
  | 'emoji'
  | 'webQuery'
  | 'fileResource'
  | 'onlineStatus'
  | 'messageSend'
>;

/** 不读任意渲染进程路径，只接受账号媒体或用户通过本应用选中的文件。 */
async function image(
  services: QQActionServices,
  path: string,
  current: () => void,
): Promise<Uint8Array> {
  const safe = await services.fileResource.resolveLocalFile(path);
  current();
  if (!safe) throw new Error('图片未授权，请重新选择文件');
  const handle = await open(safe, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 20 * 1024 * 1024)
      throw new Error('请选择 20 MB 以内的图片');
    const buffer = Buffer.alloc(info.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const bytes = buffer.subarray(0, filled);
    current();
    if (bytes.length !== info.size) throw new Error('图片读取期间发生变化，请重新选择');
    return bytes;
  } finally {
    await handle.close();
  }
}

export function createQQActionsRouter(
  resolve: (input: QQWriteBinding) => QQActionServices,
  resolveShare = resolveGroupShareAuthKey,
) {
  const busy = new WeakSet<QQActionServices>();
  const pending = new WeakMap<
    QQActionServices,
    Map<string, { request: GroupRequest; expires: number }>
  >();
  const joins = new WeakMap<
    QQActionServices,
    Map<string, { groupId: number; share: string; questionRequired: boolean; expires: number }>
  >();
  const write = async (
    input: QQWriteBinding,
    action: (s: QQActionServices, current: () => void) => Promise<unknown>,
  ) => {
    const services = resolve(input);
    if (busy.has(services)) throw new Error('请等待当前 QQ 操作完成');
    const pid = services.accountConfig.getRecord()?.qqPid;
    const current = () => {
      if (resolve(input) !== services || services.accountConfig.getRecord()?.qqPid !== pid)
        throw new Error('账号或 QQ 运行时已改变，请核对 QQ 后重新打开');
    };
    busy.add(services);
    try {
      current();
      await action(services, current);
      return accepted;
    } finally {
      busy.delete(services);
    }
  };
  const read = async <T>(
    input: QQWriteBinding,
    action: (s: QQActionServices) => Promise<T>,
  ): Promise<T> => {
    const s = resolve(input);
    const result = await action(s);
    if (resolve(input) !== s) throw new Error('账号已切换，请刷新');
    return result;
  };
  async function groupPermissions(s: QQActionServices, g: number) {
    const rows = await s.groupInfo.listGroupDirectory();
    const role = rows.find((row) => row.groupCode === String(g))?.role ?? null;
    return {
      role,
      canManage: role === 'owner' || role === 'admin',
      selfUin: s.accountWrite.selfIdentity().uin,
    };
  }
  async function manager(s: QQActionServices, g: number, current: () => void) {
    const permissions = await groupPermissions(s, g);
    current();
    if (!permissions.canManage) throw new Error('此操作需要群主或管理员权限');
  }
  return router({
    atAllMention: procedure.input(group).query(({ input: i }) =>
      read(i, async (s) => {
        const permissions = await groupPermissions(s, i.groupId);
        const quota = permissions.canManage
          ? await s.groupModeration.getAtAllRemain(i.groupId, permissions.selfUin)
          : null;
        return { ...permissions, quota };
      }),
    ),
    groupPermissions: procedure
      .input(group)
      .query(({ input: i }) => read(i, (s) => groupPermissions(s, i.groupId))),
    prepareJoin: procedure
      .input(binding.extend({ share: z.string().url().max(8192) }))
      .mutation(({ input: i }) =>
        read(i, async (s) => {
          const url = new URL(i.share);
          if (
            url.protocol !== 'https:' ||
            !['qm.qq.com', 'qun.qq.com', 'jq.qq.com'].includes(url.hostname) ||
            url.username ||
            url.password ||
            (url.port && url.port !== '443')
          )
            throw new Error('请选择有效的 QQ 群分享链接');
          let target: GroupShareTarget;
          try {
            target = parseGroupShareLocation(url.href) ?? (await resolveShare(url.href));
          } catch {
            throw new Error('无法解析 QQ 群分享链接，请重新获取分享链接');
          }
          const groupId = Number(target.groupCode);
          if (!Number.isInteger(groupId) || groupId <= 0 || groupId > 0xffffffff)
            throw new Error('分享链接的群号不合法');
          const info = await s.groupInfo.getJoinInfo(groupId).catch(() => ({
            groupId,
            name: '',
            option: null,
            question: null,
            questionState: 'unavailable' as const,
          }));
          const member = (await s.groupInfo.listGroupDirectory()).some(
            (g) => g.groupCode === String(groupId),
          );
          const cache = joins.get(s) ?? new Map();
          for (const [key, value] of cache) if (value.expires < Date.now()) cache.delete(key);
          if (cache.size >= 50) throw new Error('待提交加群目标过多，请稍后重试');
          const token = randomUUID();
          cache.set(token, {
            groupId,
            share: url.href,
            questionRequired: info.questionState === 'available',
            expires: Date.now() + 120000,
          });
          joins.set(s, cache);
          return { ...info, token, alreadyMember: member };
        }),
      ),
    join: procedure
      .input(group.extend({ token: z.string().uuid(), answer: z.string().max(1024).default('') }))
      .mutation(async ({ input: i }) => {
        let state: 'accepted' | 'unconfirmed' = 'unconfirmed';
        await write(i, async (s, current) => {
          const cache = joins.get(s),
            target = cache?.get(i.token);
          if (!target || target.expires < Date.now() || target.groupId !== i.groupId)
            throw new Error('加群目标已过期，请重新读取');
          if (target.questionRequired && !i.answer.trim()) throw new Error('请填写入群回答');
          const members = await s.groupInfo.listGroupDirectory();
          current();
          if (members.some((g) => g.groupCode === String(i.groupId)))
            throw new Error('当前账号已经在群内');
          let fresh: GroupShareTarget;
          try {
            fresh = parseGroupShareLocation(target.share) ?? (await resolveShare(target.share));
          } catch {
            throw new Error('分享链接已失效，请重新获取');
          }
          current();
          if (Number(fresh.groupCode) !== i.groupId)
            throw new Error('分享链接目标已变化，请重新读取');
          cache?.delete(i.token);
          state = await s.interaction.submitGroupJoinRequest({
            groupCode: i.groupId,
            authKey: fresh.authKey,
            answer: i.answer,
          });
        });
        return { state };
      }),
    extendedStatuses: procedure
      .input(binding)
      .query(({ input: i }) => read(i, async (s) => s.onlineStatus.editableExtendedStatuses())),
    fileSummary: procedure.input(group).query(({ input: i }) =>
      read(i, async (s) => {
        const [count, space] = await Promise.all([
          s.groupFile.count(i.groupId),
          s.groupFile.space(i.groupId),
        ]);
        return { ...count, ...space };
      }),
    ),
    fileUpload: procedure
      .input(group.extend({ path: id, directory: id.default('/') }))
      .mutation(async ({ input: i }) => {
        let state: 'accepted' | 'unconfirmed' = 'unconfirmed';
        await write(i, async (s, current) => {
          const path = await s.fileResource.resolveLocalFile(i.path);
          current();
          if (!path) throw new Error('文件未授权，请重新选择');
          const result = await s.messageSend.sendFile({
            peerType: 'group',
            targetId: i.groupId,
            path,
            folderId: i.directory,
            beforeSend: current,
          });
          state = result.ok ? 'accepted' : 'unconfirmed';
        });
        return { state };
      }),
    groupReadTools: procedure
      .input(
        group.extend({
          day: z.string().regex(/^\d{8}$/),
          offset: z.number().int().nonnegative().max(100000).default(0),
        }),
      )
      .query(({ input: i }) =>
        read(i, async (s) => {
          const [atAll, signed] = await Promise.all([
            s.groupModeration.getAtAllRemain(i.groupId, s.accountWrite.selfIdentity().uin),
            s.webQuery.getDaySignedList(String(i.groupId), {
              dayYmd: i.day,
              offset: i.offset,
              limit: 100,
            }),
          ]);
          return { atAll, signed };
        }),
      ),
    file: procedure
      .input(
        group.extend({
          action: z.enum([
            'delete',
            'rename',
            'move',
            'createFolder',
            'deleteFolder',
            'renameFolder',
          ]),
          id: id.optional(),
          directory: id.default('/'),
          name: z.string().trim().min(1).max(256).optional(),
          destination: id.optional(),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          if (i.action !== 'createFolder' && !i.id) throw new Error('缺少文件或文件夹标识');
          if (['rename', 'createFolder', 'renameFolder'].includes(i.action) && !i.name)
            throw new Error('名称不能为空');
          const permissions = await groupPermissions(s, i.groupId);
          current();
          if (!permissions.canManage) {
            if (['createFolder', 'deleteFolder', 'renameFolder'].includes(i.action))
              throw new Error('管理文件夹需要群主或管理员权限');
            const listing = await s.groupFile.list(i.groupId, i.directory);
            current();
            const file = listing.files.find((file) => file.fileId === i.id);
            if (!file || !permissions.selfUin || String(file.uploaderUin) !== permissions.selfUin)
              throw new Error('普通成员只能管理自己上传的文件，或文件已不存在');
          }
          switch (i.action) {
            case 'delete':
              return s.groupFile.deleteFile(i.groupId, i.id!);
            case 'rename':
              return s.groupFile.renameFile(i.groupId, i.id!, i.directory, i.name!);
            case 'move':
              if (!i.destination) throw new Error('请选择目标文件夹');
              return s.groupFile.moveFile(i.groupId, i.id!, i.directory, i.destination);
            case 'createFolder':
              return s.groupFile.createFolder(i.groupId, i.directory, i.name!);
            case 'deleteFolder':
              if (i.id === '/') throw new Error('不能删除根目录');
              return s.groupFile.deleteFolder(i.groupId, i.id!);
            case 'renameFolder':
              if (i.id === '/') throw new Error('不能重命名根目录');
              return s.groupFile.renameFolder(i.groupId, i.id!, i.name!);
          }
        }),
      ),
    folders: procedure
      .input(group.extend({ directory: id.default('/') }))
      .query(({ input: i }) => read(i, (s) => s.groupFile.list(i.groupId, i.directory))),
    notices: procedure
      .input(group)
      .query(({ input: i }) => read(i, (s) => s.webQuery.getGroupNotice(String(i.groupId)))),
    notice: procedure
      .input(
        group.extend({
          action: z.enum(['publish', 'delete']),
          noticeId: id.optional(),
          content: text.optional(),
          imagePath: id.optional(),
          pinned: z.boolean().default(false),
          confirmRequired: z.boolean().default(false),
          newMembers: z.boolean().default(false),
          popup: z.boolean().default(false),
          editCardGuide: z.boolean().default(false),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          await manager(s, i.groupId, current);
          if (i.action === 'delete') {
            if (!i.noticeId) throw new Error('缺少公告标识');
            return s.webQuery.deleteGroupNotice(String(i.groupId), i.noticeId, current);
          }
          if (!i.content) throw new Error('公告内容不能为空');
          const pic = i.imagePath
            ? await s.webQuery.uploadGroupNoticeImage(await image(s, i.imagePath, current), current)
            : null;
          current();
          return s.webQuery.setGroupNotice(
            String(i.groupId),
            i.content,
            {
              pinned: i.pinned ? 1 : 0,
              confirmRequired: i.confirmRequired ? 1 : 0,
              sendToNewMembers: i.newMembers,
              tipWindowType: i.popup ? 0 : 1,
              isShowEditCard: i.editCardGuide ? 0 : 1,
              ...(pic ? { picId: pic.id, imgWidth: pic.width, imgHeight: pic.height } : {}),
            },
            current,
          );
        }),
      ),
    albumUpload: procedure
      .input(album.extend({ albumName: id, path: id }))
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          const bytes = await image(s, i.path, current);
          return s.webQuery.uploadGroupAlbumImage({
            groupId: String(i.groupId),
            albumId: i.albumId,
            albumName: i.albumName,
            image: bytes,
            fileName: basename(i.path),
            beforeSend: current,
          });
        }),
      ),
    albumMedia: procedure
      .input(
        media.extend({
          action: z.enum(['delete', 'like', 'unlike', 'comment']),
          uploaderUin: z.string().regex(/^\d+$/).optional(),
          uploadTime: z.number().int().nonnegative().safe().optional(),
          content: text.optional(),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          const g = String(i.groupId),
            selfUin = s.accountWrite.selfIdentity().uin;
          if (i.action === 'delete')
            return s.groupAlbumMedia.deleteMedia(g, i.albumId, i.mediaId, i.batchId);
          if (i.action === 'comment') {
            if (!i.content) throw new Error('评论不能为空');
            return s.groupAlbumMedia.comment(
              g,
              i.albumId,
              i.batchId,
              i.mediaId,
              selfUin,
              i.content,
              current,
            );
          }
          if (!i.uploaderUin || i.uploadTime === undefined)
            throw new Error('媒体缺少上传者或时间，不能点赞');
          return s.groupAlbumMedia.setLike({
            groupId: g,
            albumId: i.albumId,
            batchId: i.batchId,
            mediaId: i.mediaId,
            uploaderUin: i.uploaderUin,
            uploadTime: i.uploadTime,
            selfUin,
            like: i.action === 'like',
          });
        }),
      ),
    favorites: procedure.input(binding).query(({ input: i }) =>
      read(i, async (s) => {
        const [ids, local] = await Promise.all([
          s.emoji.fetchOnlineFavoriteIds(),
          s.emoji.listFavoriteEmojis(),
        ]);
        const refs = ids.map(parseCustomFaceId);
        const details = await s.emoji.fetchOnlineFavoriteDetails(refs);
        return refs.map(({ emojiId, md5 }, index) => ({
          emojiId,
          position: index + 1,
          desc: details.find((d) => d.emojiId === emojiId)?.desc ?? '',
          local: local.find((f) => f.hash.toLowerCase() === md5.toLowerCase()) ?? null,
        }));
      }),
    ),
    favorite: procedure
      .input(
        binding.extend({
          action: z.enum(['add', 'delete', 'rename', 'move']),
          emojiId: id.optional(),
          path: id.optional(),
          desc: z.string().max(256).optional(),
          position: z.number().int().min(1).max(10000).optional(),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          if (i.action === 'add') {
            if (!i.path) throw new Error('请选择图片');
            return s.emoji.addFavorite(await image(s, i.path, current), undefined, current);
          }
          if (!i.emojiId) throw new Error('缺少收藏表情标识');
          if (i.action === 'delete') return s.emoji.deleteFavorite(i.emojiId);
          if (i.action === 'rename') return s.emoji.modifyFavoriteDesc(i.emojiId, i.desc ?? '');
          return s.emoji.moveFavorite(i.emojiId, i.position ?? 1, current);
        }),
      ),
    requests: procedure
      .input(binding.extend({ kind: z.enum(['friend', 'doubtFriend', 'group', 'filteredGroup']) }))
      .query(({ input: i }) =>
        read(i, async (s) => {
          if (i.kind === 'friend')
            return (await s.profile.listBuddyRequests(2000))
              .filter(isIncomingPendingBuddyRequest)
              .map((r) => ({
                token: r.peerUid,
                uid: r.peerUid,
                uin: '',
                groupId: '',
                name: r.nick || r.peerUid,
                message: r.verifyMsg,
                groupName: '',
              }));
          if (i.kind === 'doubtFriend')
            return (await s.profile.listDoubtFriendRequests()).map((r) => ({
              token: r.uid,
              uid: r.uid,
              uin: '',
              groupId: '',
              name: r.nick || r.uid,
              message: `${r.message} ${r.reason}`,
              groupName: '',
            }));
          const rows = await s.groupNotify.fetchOnlineRequests({
            filtered: i.kind === 'filteredGroup',
            maxPages: 3,
          });
          const cache = pending.get(s) ?? new Map();
          for (const [key, value] of cache) if (value.expires < Date.now()) cache.delete(key);
          if (cache.size > 1000) cache.clear();
          pending.set(s, cache);
          const self = s.accountWrite.selfIdentity();
          return rows
            .filter(
              (r) =>
                r.state === 1 &&
                Number.isSafeInteger(r.sequence) &&
                r.sequence > 0 &&
                // 这里只处理他人入群申请，不把退出、邀请及自己的申请当成审批。
                r.eventType === 7 &&
                Boolean(r.target.uid || r.target.uin > 0) &&
                !(self.uid && r.target.uid === self.uid) &&
                !(self.uin && String(r.target.uin) === self.uin),
            )
            .map((request) => {
              const token = randomUUID();
              cache.set(token, { request, expires: Date.now() + 600000 });
              return {
                token,
                uid: request.target.uid,
                uin: request.target.uin > 0 ? String(request.target.uin) : '',
                groupId: String(request.groupId),
                name: request.target.name || request.target.uid || String(request.target.uin),
                message: request.comment,
                groupName: request.groupName || String(request.groupId),
              };
            });
        }),
      ),
    request: procedure
      .input(
        binding.extend({
          kind: z.enum(['friend', 'doubtFriend', 'group', 'filteredGroup']),
          token: id,
          approve: z.boolean(),
          reason: z.string().max(256).default(''),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          if (i.kind === 'friend' || i.kind === 'doubtFriend') {
            uid.parse(i.token);
            if (i.kind === 'friend') {
              const rows = await s.profile.listBuddyRequests(2000);
              current();
              if (!rows.some((r) => r.peerUid === i.token && isIncomingPendingBuddyRequest(r)))
                throw new Error('申请已变化，请刷新');
              return s.profile.handleFriendRequest(i.token, i.approve);
            }
            const rows = await s.profile.listDoubtFriendRequests();
            current();
            if (!rows.some((r) => r.uid === i.token)) throw new Error('申请已变化，请刷新');
            return i.approve
              ? s.profile.approveDoubtFriendRequest(i.token)
              : s.profile.rejectDoubtFriendRequest(i.token);
          }
          const cache = pending.get(s),
            entry = cache?.get(i.token);
          if (!entry || entry.expires < Date.now()) throw new Error('申请已过期，请刷新');
          cache?.delete(i.token);
          return s.groupNotify.handleOnlineRequest(entry.request, i.approve, i.reason);
        }),
      ),
    todoList: procedure
      .input(group)
      .query(({ input: i }) => read(i, (s) => s.groupModeration.getTodoList(i.groupId))),
    todo: procedure
      .input(
        group.extend({
          sequence,
          action: z.enum(['set', 'complete', 'cancel']),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          if (i.action !== 'complete') await manager(s, i.groupId, current);
          return s.groupModeration.setTodo(i.groupId, BigInt(i.sequence), i.action);
        }),
      ),
    groupSettings: procedure
      .input(
        group.extend({
          action: z.enum(['leave', 'join', 'sign', 'addTag', 'deleteTag']),
          addType: z
            .union([
              z.literal(1),
              z.literal(2),
              z.literal(3),
              z.literal(4),
              z.literal(5),
              z.literal(55),
            ])
            .optional(),
          question: z.string().max(256).optional(),
          answer: z.string().max(256).optional(),
          category: z.number().int().min(0).max(0xffffffff).optional(),
          tag: z.string().trim().min(1).max(64).optional(),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          if (i.action === 'leave') return s.groupModeration.leaveGroup(i.groupId);
          if (i.action === 'sign') return s.interaction.sendGroupSign(i.groupId);
          await manager(s, i.groupId, current);
          if (i.action === 'join') {
            if (i.addType === undefined) throw new Error('请选择加群方式');
            if ([4, 5, 55].includes(i.addType) && !i.question?.trim())
              throw new Error('加群问题不能为空');
            if (i.addType === 4 && !i.answer?.trim()) throw new Error('正确答案不能为空');
            return s.groupModeration.setAddOption({
              groupId: i.groupId,
              addType: i.addType,
              groupQuestion: i.question,
              groupAnswer: i.answer,
            });
          }
          if (i.category === undefined || !i.tag) throw new Error('缺少分类和标签');
          return i.action === 'addTag'
            ? s.groupModeration.addCategoryTag(i.category, i.tag)
            : s.groupModeration.deleteCategoryTag(i.category, i.tag);
        }),
      ),
    tags: procedure
      .input(binding.extend({ category: z.number().int().min(0).max(0xffffffff) }))
      .query(({ input: i }) => read(i, (s) => s.groupModeration.getCategoryTags(i.category))),
    qzone: procedure
      .input(
        binding.extend({
          hostUin: z.string().regex(/^[1-9]\d{4,19}$/),
          tid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          action: z.enum(['like', 'unlike', 'comment']),
          content: text.optional(),
          time: z.number().int().nonnegative().safe().default(0),
          imagePath: id.optional(),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          if (i.action !== 'comment')
            return s.webQuery.setQzoneLike(i.hostUin, i.tid, i.action === 'like', i.time, current);
          if (!i.content) throw new Error('评论不能为空');
          if (!i.imagePath)
            return s.webQuery.commentQzone(
              i.hostUin,
              i.tid,
              i.content,
              undefined,
              undefined,
              current,
            );
          const picture = await s.webQuery.uploadQzoneImage(
            Buffer.from(await image(s, i.imagePath, current)).toString('base64'),
            current,
          );
          current();
          return s.webQuery.commentQzone(i.hostUin, i.tid, i.content, 1, picture.richval, current);
        }),
      ),
    inputStatus: procedure
      .input(binding.extend({ uid, eventType: z.literal(1) }))
      .mutation(({ input: i }) =>
        write(i, (s) => s.interaction.setInputStatus(i.uid, i.eventType)),
      ),
    inlineButton: procedure
      .input(
        group.extend({
          botAppid: sequence,
          buttonId: id,
          sequence,
          callbackData: z.string().max(4096).optional(),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s) => {
          const result = await s.interaction.clickInlineButton({
            groupId: i.groupId,
            botAppid: i.botAppid,
            buttonId: i.buttonId,
            msgSeq: i.sequence,
            callbackData: i.callbackData,
          });
          if (result.result !== 0)
            throw new Error(result.errMsg || result.promptText || '机器人拒绝该回调');
        }),
      ),
    liveStatus: procedure
      .input(binding)
      .query(({ input: i }) =>
        read(i, (s) => s.onlineStatus.fetchOnlineStatus(Number(s.accountWrite.selfIdentity().uin))),
      ),
  });
}
