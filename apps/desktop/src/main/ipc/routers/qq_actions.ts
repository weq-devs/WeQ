import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod/v3';
import { observeUpload, transferIdInput } from './transfer_progress';
import {
  GROUP_SELECTED_TAG_LIMIT,
  KICK_MEMBER_PER_DAY_CHOICES,
  parseCustomFaceId,
  PROFILE_LIKE_MAX_PER_REQUEST,
  type GroupRequest,
} from '@weqbot/protocol';
import { isIncomingPendingBuddyRequest } from '@weq/service/buddy-request';
import {
  FAVORITE_EMOJI_MAX_ARCHIVE_BYTES,
  FAVORITE_EMOJI_MAX_ITEMS,
  OperationError,
  runFavoriteEmojiImport,
  type PanelFavItem,
} from '@weq/service';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import type { QQWriteBinding } from './qq_write';
import { exportSavePolicyInput } from './export_save';
import { AlbumVideoStaging, StagedUploadUnavailable } from './album_video_staging';
import { backgroundTasks, taskError } from '../../background_tasks';
import { runtimeMaintenance } from '../../runtime_maintenance';
import {
  albumVideoPublished,
  lastAlbumVideoTask,
  readRecordedAccountRequest,
  recordAccountTask,
  type AlbumVideoReceipt,
} from '../../account_task_receipts';
import { updateFavoriteImportTask } from '../../favorite_import_task';
import {
  favoriteImportPlan,
  makeFavoriteImportPlan,
  pendingFavoriteImports,
  readFavoriteImportSource,
  removeFavoriteImportSource,
  updateFavoriteImportPlan,
} from '../../favorite_import_resume';
import { readFavoriteEmojiMedia } from './favorite_emoji_media';
import { runResumableExport } from '../../resumable_exports';
import { groupNoticeSequenceId, type NoticeOperationWire } from '../../../shared/contact_notices';
import { sameGroupTags } from '../../../shared/group_tags';
import { qqActionUnavailable } from '../../../shared/qq_action_availability';
import { albumMediaDeleteAllowed, qqResourceOwnedBy } from '@weq/service/qq-permissions';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
const text = z.string().trim().min(1).max(4096);
const id = z.string().min(1).max(1024);
const groupId = z.number().int().positive().max(0xffffffff);
const group = binding.extend({ groupId });
const qzoneTextPost = binding.extend({ tid: z.string().regex(/^[\da-f]{24}$/i) });
const qzoneVisibility = z.union([z.literal(1), z.literal(4), z.literal(64)]);
const groupTags = z
  .array(
    z
      .string()
      .min(1)
      .refine((tag) => Boolean(tag.trim())),
  )
  .refine((tags) => new Set(tags).size === tags.length, '群标签不能重复');
const requestInboxBinding = binding.extend({
  kind: z.enum(['friend', 'doubtFriend', 'group', 'filteredGroup']),
});
const sequence = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine(
    (value) => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn,
    '消息序号超出 uint64 范围',
  );
const groupInboxBinding = requestInboxBinding.extend({ cursor: sequence.optional() });
const groupInboxQuery = groupInboxBinding.extend({ manual: z.boolean().optional() });
const GROUP_INBOX_PAGE_LIMIT = 3;
const GROUP_APPROVAL_FRESH_MS = 10 * 60_000;
const GROUP_APPROVAL_CACHE_LIMIT = 1000;
const uid = z.string().regex(/^u_[A-Za-z0-9_-]+$/);
const album = group.extend({ albumId: id });
const videoInput = album.extend({
  uploadId: z.string().uuid().optional(),
  path: z.string().min(1).optional(),
  coverBase64: z.string().min(1),
  fileName: z.string().min(1).max(255),
  durationMs: z.number().int().safe().positive(),
  width: z.number().int().safe().positive(),
  height: z.number().int().safe().positive(),
});
const oneVideo = (value: { path?: string; uploadId?: string }) =>
  Boolean(value.path) !== Boolean(value.uploadId);
const videoPublishInput = videoInput.extend({ requestId: z.string().uuid() }).refine(oneVideo);
const videoTaskInput = album.extend({ taskId: z.string().uuid() });
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
  | 'mail'
  | 'webQuery'
  | 'fileResource'
  | 'onlineStatus'
  | 'messageSend'
  | 'peerStats'
  | 'exportManager'
  | 'favoriteEmojiImport'
>;

/** 不读任意渲染进程路径，只接受账号媒体或用户通过本应用选中的文件。 */
async function image(
  services: QQActionServices,
  path: string,
  current: () => void,
  maxBytes = 20 * 1024 * 1024,
): Promise<Buffer> {
  const safe = await services.fileResource.resolveLocalFile(path);
  current();
  if (!safe) throw new Error('图片未授权，请重新选择文件');
  const handle = await open(safe, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes)
      throw new Error(
        maxBytes === FAVORITE_EMOJI_MAX_ARCHIVE_BYTES
          ? '收藏包体积超限或为空'
          : '请选择 20 MB 以内的图片',
      );
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
  resolveStatus = resolve,
  assertWritable?: (input: QQWriteBinding) => void,
  canReportGroupNoticeRead: () => boolean = () => false,
  confirmGroupNoticeRead?: (
    input: QQWriteBinding,
    box: 'normal' | 'filtered',
    sequence: string,
  ) => void,
) {
  const busy = new WeakSet<QQActionServices>();
  const favoriteImports = new WeakMap<
    QQActionServices,
    {
      token: string;
      id: string;
      save: ReturnType<typeof recordAccountTask>;
    }
  >();
  const videoStaging = new AlbumVideoStaging(30 * 60_000, {
    label: '视频',
    minBytes: 16,
    maxBytes: Number.MAX_SAFE_INTEGER,
    prefix: 'weq-album-video-',
    fileName: 'video.mp4',
    persistence: {
      root: () => {
        const root = getAppContext().platform?.appDataRoot?.();
        return root ? join(root, 'cache', 'album-video-transfer') : undefined;
      },
      ownerKey: (owner) => {
        const record = (owner as QQActionServices).accountConfig.getRecord();
        return record?.configId ? JSON.stringify([record.uin, record.configId]) : undefined;
      },
    },
  });
  const pending = new WeakMap<
    QQActionServices,
    Map<string, { request: GroupRequest; cursor?: string; freshUntil: number; pid?: number | null }>
  >();
  const write = async (
    input: QQWriteBinding,
    action: (s: QQActionServices, current: () => void) => Promise<unknown>,
  ) => {
    assertWritable?.(input);
    const services = resolve(input);
    if (busy.has(services)) throw new Error('请等待当前 QQ 操作完成');
    const pid = services.accountConfig.getRecord()?.qqPid;
    const current = () => {
      assertWritable?.(input);
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

  function resumeFavoriteImport(input: QQWriteBinding, id: string) {
    assertWritable?.(input);
    const services = resolve(input);
    if (busy.has(services)) throw new Error('请等待当前 QQ 操作完成');
    const scope = { uin: input.expectedAccountUin, configId: input.expectedAccountConfigId };
    const task = backgroundTasks
      .snapshot()
      .find(
        (row) =>
          row.id === id &&
          row.kind === 'favorite-import' &&
          row.status !== 'running' &&
          row.scope?.configId === scope.configId &&
          row.scope.uin === scope.uin,
      );
    if (!task) throw new Error('收藏导入任务已改变，请刷新。');
    let plan = favoriteImportPlan.parse(readRecordedAccountRequest(id, scope));
    const keys = pendingFavoriteImports(plan);
    if (!keys.length) throw new Error('没有尚未提交的表情。');
    const save = recordAccountTask(id, scope);
    const stop = new AbortController();
    backgroundTasks.resume(id);
    backgroundTasks.setActions(id, [
      {
        id: 'stop',
        label: '停止后续导入',
        run: () => {
          stop.abort();
        },
      },
    ]);
    const work = write(input, async (currentServices, check) => {
      const items = await readFavoriteImportSource(scope.configId, id);
      check();
      const outcome = await runFavoriteEmojiImport(items, keys, currentServices.emoji, {
        current: check,
        signal: stop.signal,
        journal: (result) => {
          const next = updateFavoriteImportPlan(plan, result);
          save(next);
          plan = next;
        },
        progress: (result) =>
          updateFavoriteImportTask(id, {
            result: { ...result, items: plan.items },
            phase: 'running',
            error: null,
            cancelling: stop.signal.aborted,
          }),
      });
      updateFavoriteImportTask(id, {
        result: { ...outcome, items: plan.items },
        phase: 'finished',
        error: null,
        cancelling: stop.signal.aborted,
      });
    });
    void work
      .catch((error) => {
        backgroundTasks.finish(id, 'failed', { note: taskError(error) });
      })
      .finally(() => {
        if (pendingFavoriteImports(plan).length) {
          backgroundTasks.setActions(id, [
            {
              id: 'retry',
              label: '继续导入未提交的表情',
              run: () => resumeFavoriteImport(input, id),
            },
          ]);
        } else {
          backgroundTasks.setActions(id, []);
          void removeFavoriteImportSource(scope.configId, id).catch(() => undefined);
        }
        try {
          save(plan);
        } catch (error) {
          console.warn('[收藏导入] 回执保存失败', error);
        }
      });
    return true;
  }

  async function loadRequestInbox(
    s: QQActionServices,
    kind: z.infer<typeof requestInboxBinding>['kind'],
    options: { cursor?: string; maxPages?: number; manual?: boolean } = {},
  ): Promise<{
    operations: NoticeOperationWire[];
    readSequence: string | null;
    nextCursor?: string;
  }> {
    if (kind === 'friend')
      return {
        operations: (await s.profile.listBuddyRequests(2000))
          .filter(isIncomingPendingBuddyRequest)
          .map((r) => ({
            token: r.peerUid,
            noticeId: r.timestamp > 0 ? `buddy-request:${r.peerUid}:${r.timestamp}` : undefined,
            uid: r.peerUid,
            uin: '',
            groupId: '',
            name: r.nick || r.peerUid,
            message: r.verifyMsg,
            groupName: '',
          })),
        readSequence: null,
      };
    if (kind === 'doubtFriend')
      return {
        operations: (await s.profile.listDoubtFriendRequests()).map((r) => ({
          token: r.uid,
          noticeId:
            r.requestTime > 0
              ? `buddy-request:${r.uid}:${r.requestTime}`
              : `doubt-buddy-request:${r.uid}`,
          uid: r.uid,
          uin: '',
          groupId: '',
          name: r.nick || r.uid,
          message: `${r.message} ${r.reason}`,
          groupName: '',
        })),
        readSequence: null,
      };
    const filtered = kind === 'filteredGroup';
    const pid = s.accountConfig.getRecord()?.qqPid;
    const inbox = await s.groupNotify.fetchOnlineInbox({
      filtered,
      maxPages: options.maxPages ?? GROUP_INBOX_PAGE_LIMIT,
      cursor: options.cursor ? BigInt(options.cursor) : undefined,
      manual: options.manual,
    });
    const cache = pending.get(s) ?? new Map();
    pending.set(s, cache);
    const self = s.accountWrite.selfIdentity();
    const operations = inbox.requests
      .filter(
        (r) =>
          r.state === 1 &&
          Number.isSafeInteger(r.sequence) &&
          r.sequence > 0 &&
          (r.eventType === 1 || r.eventType === 7) &&
          Boolean(r.target.uid || r.target.uin > 0) &&
          !(self.uid && r.target.uid === self.uid) &&
          !(self.uin && String(r.target.uin) === self.uin),
      )
      .map((request) => {
        const token = randomUUID();
        const sequence = (request.rawSequence ?? request.sequence).toString();
        cache.set(token, {
          request,
          cursor: options.cursor,
          freshUntil: Date.now() + GROUP_APPROVAL_FRESH_MS,
          pid,
        });
        return {
          token,
          noticeId: groupNoticeSequenceId(sequence, filtered),
          sequence,
          ...(options.cursor ? { inboxCursor: options.cursor } : {}),
          uid: request.target.uid,
          uin: request.target.uin > 0 ? String(request.target.uin) : '',
          groupId: String(request.groupId),
          name: request.target.name || request.target.uid || String(request.target.uin),
          message: request.comment,
          groupName: request.groupName || String(request.groupId),
        };
      });
    while (cache.size > GROUP_APPROVAL_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return {
      operations,
      readSequence: inbox.readSequence?.toString() ?? null,
      nextCursor: inbox.nextCursor?.toString(),
    };
  }
  async function groupPermissions(s: QQActionServices, g: number) {
    const context = await s.groupInfo.operationContext(g);
    const role = context.role ?? null;
    return {
      ...context,
      role,
      canManage: role === 'owner' || role === 'admin',
      selfUin: s.accountWrite.selfIdentity().uin,
      selfUid: s.accountWrite.selfIdentity().uid,
    };
  }
  async function manager(s: QQActionServices, g: number, current: () => void) {
    const permissions = await groupPermissions(s, g);
    current();
    if (!permissions.canManage) throw new Error('此操作需要群主或管理员权限');
  }
  const readManagedJoinSettings = (input: QQWriteBinding & { groupId: number }) =>
    read(input, async (s) => {
      await manager(s, input.groupId, () => {
        if (resolve(input) !== s) throw new Error('账号已切换，请刷新');
      });
      return s.groupModeration.joinSettings(input.groupId);
    });

  async function adminTarget(s: QQActionServices, groupId: number, targetUid: string) {
    const [context, member] = await Promise.all([
      s.groupInfo.operationContext(groupId, targetUid),
      s.groupInfo.getMemberInfo(BigInt(groupId), targetUid),
    ]);
    if (context.role !== 'owner' || context.targetRole !== 'admin' || context.isSelf)
      throw new Error('只有群主可以管理该管理员的权限');
    const userId = Number(member?.uin);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('无法核对管理员身份');
    return userId;
  }
  async function albumPermission(
    s: QQActionServices,
    groupId: number,
    albumId: string,
    operation: 'modify' | 'upload' | 'deleteAlbum',
    current: () => void,
  ) {
    const page = await s.groupAlbumMedia.getMediaList(String(groupId), albumId);
    current();
    if (!page.capabilities?.[operation])
      throw new Error('当前账号没有此相册操作权限，请刷新相册后重试');
  }
  async function uploadAlbumVideo(input: z.infer<typeof videoInput>, sending?: () => void) {
    let videoId: string | null = null;
    await write(input, async (services, current) => {
      const path = input.uploadId
        ? videoStaging.complete(services, input.uploadId)
        : await services.fileResource.resolveLocalFile(input.path!);
      let consumed = false;
      try {
        current();
        if (!path) throw new Error('视频文件未授权或已不可用，请重新选择');
        const albums = await services.webQuery.getGroupAlbumList(String(input.groupId), current);
        const selected = albums.find((row) => row.id === input.albumId);
        if (!selected) throw new Error('目标相册不存在或不可见');
        await albumPermission(services, input.groupId, input.albumId, 'upload', current);
        const cover = Buffer.from(input.coverBase64, 'base64');
        if (cover.toString('base64') !== input.coverBase64) throw new Error('媒体编码无效');
        current();
        if (input.uploadId) {
          await videoStaging.consume(services, input.uploadId);
          consumed = true;
        }
        sending?.();
        const result = await services.webQuery.uploadGroupAlbumVideo({
          groupId: String(input.groupId),
          albumId: input.albumId,
          albumName: selected.title,
          fileName: input.fileName,
          video: path,
          cover,
          durationMs: input.durationMs,
          width: input.width,
          height: input.height,
          beforeSend: current,
        });
        videoId = result.videoId;
      } finally {
        if (input.uploadId && consumed)
          await videoStaging
            .discard(services, input.uploadId, true)
            .catch((error: unknown) => console.warn('[群相册] 清理视频暂存失败', error));
      }
    });
    return videoId as string | null;
  }

  const albumScope = (input: QQWriteBinding) => ({
    uin: input.expectedAccountUin,
    configId: input.expectedAccountConfigId,
  });
  const albumTask = (input: z.infer<typeof album>): ReturnType<typeof lastAlbumVideoTask> => {
    resolveStatus(input);
    return lastAlbumVideoTask(
      albumScope(input),
      String(input.groupId),
      input.albumId,
      (taskId, scope) =>
        resumeAlbumVideo(
          { expectedAccountUin: scope.uin, expectedAccountConfigId: scope.configId! },
          taskId,
        ),
    );
  };

  async function resumeAlbumVideo(input: QQWriteBinding, id: string): Promise<string> {
    const scope = albumScope(input);
    const receipt = readRecordedAccountRequest(id, scope) as AlbumVideoReceipt | undefined;
    if (!receipt || receipt.submitted || !receipt.prepared)
      throw new Error('之前的上传结果需要核对。');
    const prepared = videoPublishInput.parse(receipt.prepared);
    if (
      !prepared.uploadId ||
      prepared.expectedAccountUin !== scope.uin ||
      prepared.expectedAccountConfigId !== scope.configId ||
      prepared.requestId !== receipt.requestId
    )
      throw new Error('上传记录已改变，请重新选择视频。');
    const existing = albumTask(prepared);
    if (existing?.id !== id || existing.status === 'running')
      throw new Error('上传批次已改变，请刷新相册。');
    const services = resolve(prepared);
    await videoStaging.restoreComplete(services, prepared.uploadId);
    if (resolve(prepared) !== services) throw new Error('账号或数据源已切换。');
    return startAlbumVideo(prepared, id);
  }

  function startAlbumVideo(input: z.infer<typeof videoPublishInput>, existingId?: string): string {
    const previous = albumTask(input);
    if (!existingId && previous?.ownerId === input.requestId) return previous.id;
    if (existingId && previous?.id !== existingId) throw new Error('上传批次已改变，请刷新相册。');
    if (previous?.status === 'running') throw new Error('这个相册正在上传视频');
    assertWritable?.(input);
    const services = resolve(input);
    if (busy.has(services)) throw new Error('请等待当前 QQ 操作完成');
    const scope = albumScope(input);
    const groupAlbum = { groupCode: String(input.groupId), albumId: input.albumId };
    const receipt: AlbumVideoReceipt = {
      ...groupAlbum,
      requestId: input.requestId,
      submitted: false,
      prepared: input.uploadId ? input : undefined,
    };
    const taskId =
      existingId ??
      backgroundTasks.start({
        kind: 'album-upload',
        scope,
        groupAlbum,
        ownerId: input.requestId,
        foreground: true,
        name: input.fileName,
        display: {
          action: '上传群相册视频',
          subject: input.fileName,
          context: `群 ${input.groupId} · 相册 ${input.albumId}`,
          fileName: true,
        },
        statusLabel: '正在准备上传',
      });
    backgroundTasks.resume(taskId);
    backgroundTasks.setActions(taskId, []);
    const save = recordAccountTask(taskId, scope);
    const current = () => {
      if (resolve(input) !== services) throw new Error('请回到原账号和数据源核对');
    };
    const complete = () => {
      backgroundTasks.resume(taskId);
      backgroundTasks.finish(taskId, 'completed', {
        note: '视频已发布到群相册并读回确认',
        needsConfirmation: false,
      });
      backgroundTasks.setActions(taskId, []);
      try {
        save(receipt);
      } catch (error) {
        console.warn('[群相册] 上传回执保存失败', error);
      }
    };
    const verify = async () => {
      current();
      if (!(await albumVideoPublished(services, scope, receipt, current)))
        throw new Error('暂未在该相册读到原视频，可稍后继续核对。');
      complete();
    };
    void (async () => {
      try {
        save(receipt);
        const videoId = await runtimeMaintenance.operation(
          () =>
            uploadAlbumVideo(input, () => {
              save({ ...receipt, submitted: true, prepared: undefined });
              receipt.submitted = true;
              receipt.prepared = undefined;
              backgroundTasks.update(taskId, { statusLabel: '正在上传到 QQ 并发布' });
            }),
          '上传群相册视频',
        );
        receipt.videoId = videoId ?? undefined;
        backgroundTasks.update(taskId, { statusLabel: '正在核对群相册结果' });
        save(receipt);
        const signal = AbortSignal.timeout(15000);
        for (const delay of [0, 350, 1000, 2500]) {
          if (delay) await wait(delay, undefined, { signal });
          current();
          if (
            await albumVideoPublished(services, scope, receipt, current, signal).catch(() => false)
          ) {
            complete();
            return;
          }
        }
        throw new Error('暂未在该相册读到原视频，可稍后继续核对。');
      } catch (error) {
        backgroundTasks.finish(
          taskId,
          receipt.submitted || receipt.prepared ? 'paused' : 'failed',
          {
            statusLabel: receipt.submitted
              ? '上传结果待核对'
              : receipt.prepared
                ? '等待继续上传'
                : undefined,
            needsConfirmation: receipt.submitted,
            note: taskError(error),
          },
        );
        if (receipt.videoId)
          backgroundTasks.setActions(taskId, [
            { id: 'verify', label: '核对上传结果', run: verify },
          ]);
        if (!receipt.submitted && receipt.prepared)
          backgroundTasks.setActions(taskId, [
            {
              id: 'continue',
              label: '继续上传到 QQ',
              run: () => resumeAlbumVideo(input, taskId),
            },
          ]);
        try {
          save(receipt);
        } catch (failure) {
          console.warn('[群相册] 上传回执保存失败', failure);
        }
      }
    })();
    return taskId;
  }

  return router({
    onlineSystemFaces: procedure
      .input(binding)
      .query(({ input: i }) => read(i, (s) => s.emoji.onlineSystemFaces())),
    onlineSystemFace: procedure
      .input(binding.extend({ faceId: z.number().int().min(0).max(0xffffffff) }))
      .query(({ input: i }) => read(i, (s) => s.emoji.onlineSystemFace(i.faceId))),
    onlinePerson: procedure
      .input(binding.extend({ uin: z.string().regex(/^[1-9]\d{4,15}$/) }))
      .query(({ input: i }) => read(i, (s) => s.accountWrite.onlinePerson(i.uin))),
    deleteFriend: procedure
      .input(binding.extend({ targetUid: uid }))
      .mutation(async ({ input: i }) => {
        const outcome: { state: 'confirmed' | 'unconfirmed' } = { state: 'unconfirmed' };
        await write(i, async (s, current) => {
          const result = await s.accountWrite.deleteFriend(i.targetUid, current);
          if (result.state === 'confirmed') outcome.state = 'confirmed';
        });
        return outcome;
      }),
    translateEnglish: procedure
      .input(binding.extend({ text }))
      .mutation(({ input: i }) => read(i, (s) => s.interaction.translateEnglish(i.text))),
    miniAppCard: procedure
      .input(
        binding.extend({
          type: z.enum(['bili', 'weibo']),
          title: z.string().trim().min(1).max(128),
          desc: z.string().trim().max(512),
          picUrl: z.string().max(2048),
          jumpUrl: z.string().url().max(2048),
        }),
      )
      .mutation(({ input: i }) => read(i, (s) => s.interaction.miniAppCard(i))),
    aiVoiceCatalog: procedure.input(group).query(({ input: i }) =>
      read(i, async (s) => {
        const groups = await s.groupInfo.listGroupDirectory();
        if (!groups.some((entry) => entry.groupCode === String(i.groupId)))
          throw new Error('当前账号未加入该群');
        return s.messageSend.aiVoiceCatalog(i.groupId);
      }),
    ),
    signatureLike: procedure
      .input(
        binding.extend({
          uin: z.string().regex(/^[1-9]\d{0,19}$/),
          id: z.string().regex(/^(?:[\da-f]{2}){1,512}$/i),
          createdAt: z.number().int().min(0).max(0xffffffff),
          liked: z.boolean(),
        }),
      )
      .mutation(({ input }) =>
        write(input, async (s, current) => {
          await s.accountWrite.signatureLike(input.uin, input, input.liked);
          current();
        }),
      ),
    signatureComment: procedure
      .input(
        binding.extend({
          uin: z.string().regex(/^[1-9]\d{0,19}$/),
          id: z.string().regex(/^(?:[\da-f]{2}){1,512}$/i),
          text: z.string().trim().min(1).max(4096),
          replyId: z
            .string()
            .regex(/^\d{1,20}$/)
            .optional(),
        }),
      )
      .mutation(async ({ input }) => {
        let commentId: string | undefined;
        await write(input, async (s, current) => {
          commentId = (
            await s.accountWrite.signatureComment(input.uin, input.id, input.text, input.replyId)
          ).commentId;
          current();
        });
        return { state: 'accepted' as const, commentId };
      }),
    deleteSignatureComment: procedure
      .input(
        binding.extend({
          uin: z.string().regex(/^[1-9]\d{0,19}$/),
          id: z.string().regex(/^(?:[\da-f]{2}){1,512}$/i),
          createdAt: z.number().int().min(0).max(0xffffffff),
          commentId: sequence,
        }),
      )
      .mutation(({ input }) =>
        write(input, async (s, current) => {
          await s.accountWrite.deleteSignatureComment(input.uin, input, input.commentId);
          current();
        }),
      ),
    personalityPhotoUpload: procedure
      .input(
        binding
          .extend({
            uin: z.string().regex(/^[1-9]\d{0,19}$/),
            labelId: sequence,
            imagePath: z.string().min(1),
            count: z.number().int().min(1).max(100).default(1),
            index: z.number().int().min(0).max(99).default(0),
            timestamp: z.number().int().min(0).max(0xffffffff),
          })
          .refine((value) => value.index < value.count),
      )
      .mutation(async ({ input }) => {
        let uploaded:
          | Awaited<ReturnType<QQActionServices['accountWrite']['uploadPersonalityPhoto']>>
          | undefined;
        await write(input, async (s, current) => {
          const bytes = await image(s, input.imagePath, current);
          current();
          uploaded = await s.accountWrite.uploadPersonalityPhoto(
            input.uin,
            input.labelId,
            bytes,
            input,
          );
          current();
        });
        if (!uploaded) throw new Error('照片上传未返回结果');
        return uploaded;
      }),
    albumVideoStart: procedure
      .input(binding.extend({ size: z.number().int().safe().min(16) }))
      .mutation(({ input }) => videoStaging.start(resolve(input), input.size)),
    albumVideoResume: procedure
      .input(binding.extend({ uploadId: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const services = resolve(input);
        const resumed = await videoStaging.resume(services, input.uploadId).catch((error) => {
          if (error instanceof StagedUploadUnavailable) return null;
          throw error;
        });
        if (resolve(input) !== services) throw new Error('账号已切换，已停止视频暂存');
        return resumed;
      }),
    albumVideoChunk: procedure
      .input(
        binding.extend({
          uploadId: z.string().uuid(),
          offset: z.number().int().safe().min(0),
          base64: z.string().min(1).max(1398104),
        }),
      )
      .mutation(async ({ input }) => {
        if (Buffer.from(input.base64, 'base64').toString('base64') !== input.base64)
          throw new Error('视频分段编码无效');
        const s = resolve(input);
        const result = await videoStaging.append(
          s,
          input.uploadId,
          input.offset,
          Buffer.from(input.base64, 'base64'),
        );
        if (resolve(input) !== s) throw new Error('账号已切换，已停止视频暂存');
        return result;
      }),
    albumVideoDiscard: procedure
      .input(binding.extend({ uploadId: z.string().uuid() }))
      .mutation(({ input }) => videoStaging.discard(resolveStatus(input), input.uploadId)),
    albumVideoUpload: procedure.input(videoInput.refine(oneVideo)).mutation(async ({ input }) => ({
      state: 'unconfirmed' as const,
      videoId: await uploadAlbumVideo(input),
    })),
    albumVideoPublish: procedure
      .input(videoPublishInput)
      .mutation(({ input }) => startAlbumVideo(input)),
    albumVideoResumeTask: procedure
      .input(binding.extend({ taskId: z.string().uuid() }))
      .mutation(({ input }) => resumeAlbumVideo(input, input.taskId)),
    albumVideoStatus: procedure.input(album).query(({ input }) => {
      const task = albumTask(input);
      if (!task) return null;
      const { id, ownerId, name, status, statusLabel, note, foreground, actions } = task;
      return {
        id,
        requestId: ownerId,
        name,
        status,
        statusLabel,
        note,
        foreground,
        canVerify: actions.some((action) => action.id === 'verify'),
        canContinue: actions.some((action) => action.id === 'continue' || action.id === 'retry'),
      };
    }),
    albumVideoBackground: procedure.input(videoTaskInput).mutation(({ input }) => {
      const task = albumTask(input);
      if (task?.id !== input.taskId) throw new Error('上传批次已改变，请刷新相册');
      if (!task.foreground) return false;
      backgroundTasks.setForeground(task.id, false);
      try {
        recordAccountTask(task.id, albumScope(input))();
      } catch (error) {
        backgroundTasks.setForeground(task.id, true);
        throw error;
      }
      return true;
    }),
    albumVideoVerify: procedure.input(videoTaskInput).mutation(async ({ input }) => {
      const task = albumTask(input);
      if (task?.id !== input.taskId) throw new Error('上传批次已改变，请刷新相册');
      if (task.status === 'completed') return true;
      await backgroundTasks.act(task.id, 'verify');
      return true;
    }),
    qzoneFriendPermissionList: procedure
      .input(binding.extend({ kind: z.enum(['blocked', 'hidden']) }))
      .query(({ input }) =>
        read(input, (s) => s.webQuery.getQzoneFriendPermissionList(input.kind)),
      ),
    qzoneFriendPermission: procedure
      .input(
        binding.extend({
          kind: z.enum(['blocked', 'hidden']),
          targetUin: z.string().regex(/^[1-9]\d{4,11}$/),
          enabled: z.boolean(),
        }),
      )
      .mutation(({ input }) =>
        write(input, (s, current) =>
          s.webQuery.setQzoneFriendPermission(input.kind, input.targetUin, input.enabled, current),
        ),
      ),
    albumManagement: procedure
      .input(
        group.extend({
          action: z.enum(['create', 'modify', 'delete']),
          albumId: id.optional(),
          title: z.string().trim().min(1).max(30).optional(),
          description: z.string().max(2000).optional(),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          const g = String(i.groupId);
          const albums = await s.webQuery.getGroupAlbumList(g, current);
          current();
          if (i.action === 'create') {
            const permission = await s.webQuery.getGroupAlbumUploadPermission(g);
            current();
            if (!permission.allowed) throw new Error('当前账号不能创建群相册');
            if (!i.title) throw new Error('相册名称不能为空');
            await s.webQuery.createGroupAlbum({
              groupId: g,
              title: i.title,
              description: i.description ?? '',
              beforeSend: current,
            });
          } else {
            const album = albums.find((row) => row.id === i.albumId);
            if (!album) throw new Error('相册已不存在或当前账号不可见');
            await albumPermission(
              s,
              i.groupId,
              album.id,
              i.action === 'delete' ? 'deleteAlbum' : 'modify',
              current,
            );
            if (i.action === 'delete')
              await s.webQuery.deleteGroupAlbum({
                groupId: g,
                albumId: album.id,
                beforeSend: current,
              });
            else {
              if (!i.title) throw new Error('相册名称不能为空');
              const details = await s.webQuery.getGroupAlbumDetails(
                g,
                album.id,
                String(album.createUin),
              );
              current();
              await s.webQuery.modifyGroupAlbum({
                groupId: g,
                albumId: album.id,
                title: i.title,
                description: i.description ?? '',
                privacy: details.privacy,
                ...(details.lloc === undefined ? {} : { lloc: details.lloc }),
                beforeSend: current,
              });
            }
          }
        }),
      ),
    profileLike: procedure
      .input(
        binding.extend({ uid, count: z.number().int().min(1).max(PROFILE_LIKE_MAX_PER_REQUEST) }),
      )
      .mutation(async ({ input: i }) => {
        let state: 'accepted' | 'unconfirmed' = 'unconfirmed';
        await write(i, async (s) => {
          if (s.accountWrite.selfIdentity().uid === i.uid) throw new Error('不能给自己点赞');
          state = await s.peerStats.sendLike(i.uid, i.count);
        });
        return { state };
      }),
    albumPermissions: procedure
      .input(group.extend({ albumId: id.optional() }))
      .query(({ input: i }) =>
        read(i, async (s) => {
          if (i.albumId)
            return (await s.groupAlbumMedia.getMediaList(String(i.groupId), i.albumId))
              .capabilities;
          const permission = await s.webQuery.getGroupAlbumUploadPermission(String(i.groupId));
          return {
            create: permission.allowed,
            modify: false,
            upload: false,
            deleteMedia: false,
            top: false,
            deleteAlbum: false,
          };
        }),
      ),
    atAllMention: procedure.input(group).query(({ input: i }) =>
      read(i, async (s) => {
        const permissions = await groupPermissions(s, i.groupId);
        const quota = permissions.canManage
          ? await s.groupModeration.getAtAllRemain(i.groupId, permissions.selfUin)
          : null;
        return { ...permissions, quota };
      }),
    ),
    groupPermissions: procedure.input(group).query(({ input: i }) =>
      read(i, async (s) => {
        const permissions = await groupPermissions(s, i.groupId);
        return {
          ...permissions,
          ...(await s.groupInfo.ownAdminRestrictions(i.groupId, permissions.role)),
        };
      }),
    ),
    groupAdminPermissions: procedure.input(group.extend({ targetUid: uid })).query(({ input: i }) =>
      read(i, async (s) => {
        const userId = await adminTarget(s, i.groupId, i.targetUid);
        const permissions = await s.groupInfo.adminPermissions(i.groupId, userId);
        return { ...permissions, kickMemberPerDayChoices: KICK_MEMBER_PER_DAY_CHOICES };
      }),
    ),
    setGroupAdminPermissions: procedure
      .input(
        group.extend({
          targetUid: uid,
          recallMemberMessage: z.boolean().optional(),
          kickMember: z.boolean().optional(),
          kickMemberPerDay: z.number().int().min(0).max(200).optional(),
        }),
      )
      .mutation(({ input: i }) => {
        const unavailable = qqActionUnavailable.setGroupAdminPermissions;
        if (unavailable) throw new OperationError(unavailable, 'expected');
        return write(i, async (s, current) => {
          const userId = await adminTarget(s, i.groupId, i.targetUid);
          const before = await s.groupInfo.adminPermissions(i.groupId, userId);
          current();
          if (
            (i.recallMemberMessage !== undefined && before.recallMemberMessage === null) ||
            (i.kickMember !== undefined && before.kickMember === null)
          )
            throw new Error('服务端未返回对应权限，请刷新后重试');
          await s.groupModeration.setAdminPermissions(i.groupId, userId, i.targetUid, {
            ...(i.recallMemberMessage === undefined
              ? {}
              : { recallMemberMessage: i.recallMemberMessage }),
            ...(i.kickMember === undefined ? {} : { kickMember: i.kickMember }),
            ...(i.kickMemberPerDay === undefined ? {} : { kickMemberPerDay: i.kickMemberPerDay }),
          });
        });
      }),
    groupAdminReceiveVerify: procedure
      .input(group.extend({ targetUid: uid }))
      .query(({ input: i }) =>
        read(i, async (s) => {
          const userId = await adminTarget(s, i.groupId, i.targetUid);
          return s.groupModeration.adminReceiveVerify(i.groupId, userId, i.targetUid);
        }),
      ),
    setGroupAdminReceiveVerify: procedure
      .input(group.extend({ targetUid: uid, enable: z.boolean() }))
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          const userId = await adminTarget(s, i.groupId, i.targetUid);
          const before = await s.groupModeration.adminReceiveVerify(i.groupId, userId, i.targetUid);
          current();
          if (before === null) throw new Error('服务端未返回接收验证消息的状态');
          if (before !== i.enable)
            await s.groupModeration.setAdminReceiveVerify(i.groupId, userId, i.targetUid, i.enable);
        }),
      ),
    groupAdvancedSettings: procedure.input(group).query(({ input: i }) =>
      read(i, async (s) => {
        await manager(s, i.groupId, () => {});
        return s.groupModeration.advancedSettings(i.groupId);
      }),
    ),
    setGroupAdvancedSetting: procedure
      .input(
        group.extend({
          change: z.discriminatedUnion('key', [
            z.object({
              key: z.enum([
                'newMemberHistory',
                'allowMemberUploadAlbum',
                'allowMemberTemporarySession',
                'allowMemberCreateGroup',
                'robotMemberSwitch',
                'robotMemberExamine',
              ]),
              value: z.boolean(),
            }),
            z.object({
              key: z.literal('searchMode'),
              value: z.enum(['keyword_or_number', 'number_only', 'disabled']),
            }),
            z.object({
              key: z.literal('invitePolicy'),
              value: z.enum([
                'disabled',
                'require_approval',
                'no_approval',
                'no_approval_under_100',
              ]),
            }),
          ]),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, (s, current) =>
          s.groupModeration.setAdvancedSetting(i.groupId, i.change, current),
        ),
      ),
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
          current();
          switch (i.action) {
            case 'delete':
              return s.groupFile.deleteFile(i.groupId, i.id!, i.directory, current);
            case 'rename':
              return s.groupFile.renameFile(i.groupId, i.id!, i.directory, i.name!, current);
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
    makeGroupFilePermanent: procedure
      .input(group.extend({ fileId: id, directory: id.default('/') }))
      .mutation(
        async ({ input: i }): ReturnType<QQActionServices['groupFile']['makePermanent']> => {
          let result: Awaited<ReturnType<QQActionServices['groupFile']['makePermanent']>> = {
            state: 'unconfirmed',
            fileId: null,
            directory: null,
          };
          await write(i, async (s, current) => {
            result = await s.groupFile.makePermanent(i.groupId, i.fileId, i.directory, current);
          });
          return result;
        },
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
          await albumPermission(s, i.groupId, i.albumId, 'upload', current);
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
          if (i.action === 'delete') {
            const permissions = await groupPermissions(s, i.groupId);
            current();
            const first = await s.groupAlbumMedia.getMediaList(g, i.albumId);
            current();
            if (!albumMediaDeleteAllowed(first.capabilities, false)) {
              let cursor = '';
              const seen = new Set<string>();
              let owner = '';
              for (let page = 0; page < 100; page++) {
                const result = cursor
                  ? await s.groupAlbumMedia.getMediaList(g, i.albumId, cursor)
                  : first;
                current();
                const item = result.mediaList.find(
                  (row) =>
                    row.batchId === i.batchId &&
                    (row.image?.lloc === i.mediaId || row.video?.cover?.lloc === i.mediaId),
                );
                if (item) {
                  owner = item.uploader;
                  break;
                }
                if (
                  !result.nextAttachInfo ||
                  seen.has(result.nextAttachInfo) ||
                  !result.mediaList.length
                )
                  break;
                seen.add(result.nextAttachInfo);
                cursor = result.nextAttachInfo;
              }
              if (!qqResourceOwnedBy(owner, { uid: permissions.selfUid, uin: permissions.selfUin }))
                throw new Error('只有上传者或群管理员可以删除这项媒体。');
            }
            return s.groupAlbumMedia.deleteMedia(g, i.albumId, i.mediaId, i.batchId);
          }
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
    favoriteIds: procedure
      .input(binding)
      .query(({ input: i }) => read(i, (s) => s.emoji.fetchOnlineFavoriteIds())),
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
    favoriteImportPreview: procedure
      .input(binding.extend({ path: z.string().min(1).max(8192) }))
      .mutation(({ input: i }) =>
        read(i, async (s) => {
          const pid = s.accountConfig.getRecord()?.qqPid;
          const current = () => {
            if (resolve(i) !== s || s.accountConfig.getRecord()?.qqPid !== pid)
              throw new Error('账号或 QQ 运行时已改变，请重新选择收藏包');
          };
          return s.favoriteEmojiImport.prepare(
            () => image(s, i.path, current, FAVORITE_EMOJI_MAX_ARCHIVE_BYTES),
            current,
          );
        }),
      ),
    favoriteImportState: procedure.input(binding).query(({ input: i }) => {
      const services = resolveStatus(i);
      const view = services.favoriteEmojiImport.read();
      const tracked = favoriteImports.get(services);
      if (!view) return null;
      const task =
        tracked?.token === view.token
          ? backgroundTasks.snapshot().find((task) => task.id === tracked.id)
          : undefined;
      return { ...view, backgrounded: Boolean(task && !task.foreground) };
    }),
    favoriteImportStart: procedure
      .input(
        binding.extend({
          token: z.string().uuid(),
          keys: z.array(z.string().min(1).max(64)).min(1).max(FAVORITE_EMOJI_MAX_ITEMS),
        }),
      )
      .mutation(async ({ input: i }) => {
        const s = resolve(i);
        if (busy.has(s)) throw new Error('请等待当前 QQ 操作完成');
        assertWritable?.(i);
        const scope = { uin: i.expectedAccountUin, configId: i.expectedAccountConfigId };
        const id = backgroundTasks.start({
          kind: 'favorite-import',
          foreground: true,
          name: '收藏表情导入',
          display: { action: '导入收藏表情', subject: `${i.keys.length} 张`, numericSubject: true },
          scope,
        });
        const save = recordAccountTask(id, scope);
        busy.add(s);
        try {
          let plan = await makeFavoriteImportPlan(
            scope.configId,
            id,
            s.favoriteEmojiImport.snapshotSelection(i.token, i.keys),
          );
          if (resolve(i) !== s) throw new Error('账号或数据源已切换，请重新选择收藏包。');
          assertWritable?.(i);
          save(plan);
          const view = s.favoriteEmojiImport.start(
            i.token,
            i.keys,
            async (run) => {
              try {
                return await run();
              } finally {
                busy.delete(s);
              }
            },
            (view) => {
              updateFavoriteImportTask(id, view);
              save(plan);
              if (view.phase === 'finished') {
                if (pendingFavoriteImports(plan).length)
                  backgroundTasks.setActions(id, [
                    {
                      id: 'retry',
                      label: '继续导入未提交的表情',
                      run: () => resumeFavoriteImport(i, id),
                    },
                  ]);
                else void removeFavoriteImportSource(scope.configId, id).catch(() => undefined);
              }
            },
            (result) => {
              const next = updateFavoriteImportPlan(plan, result);
              save(next);
              plan = next;
            },
          );
          backgroundTasks.setActions(id, [
            {
              id: 'stop',
              label: '停止后续导入',
              run: () => {
                s.favoriteEmojiImport.cancel(i.token);
                backgroundTasks.update(id, { statusLabel: '停止收尾中' });
              },
            },
          ]);
          favoriteImports.set(s, { token: i.token, id, save });
          return view;
        } catch (error) {
          busy.delete(s);
          await removeFavoriteImportSource(scope.configId, id).catch(() => undefined);
          backgroundTasks.finish(id, 'failed', { note: taskError(error) });
          try {
            save();
          } catch {
            /* 保留原保存或启动错误。 */
          }
          throw error;
        }
      }),
    favoriteImportResume: procedure
      .input(binding.extend({ taskId: z.string().uuid() }))
      .mutation(({ input }) => resumeFavoriteImport(input, input.taskId)),
    favoriteImportBackground: procedure
      .input(binding.extend({ token: z.string().uuid() }))
      .mutation(({ input: i }) => {
        const services = resolveStatus(i);
        const view = services.favoriteEmojiImport.read();
        const tracked = favoriteImports.get(services);
        if (
          !tracked ||
          tracked.token !== i.token ||
          view?.token !== i.token ||
          (view.phase !== 'running' && view.phase !== 'finished')
        )
          throw new Error('此导入批次已改变，请刷新');
        const task = backgroundTasks.snapshot().find((candidate) => candidate.id === tracked.id);
        if (!task) throw new Error('导入进度已失效，请刷新收藏结果');
        if (task.foreground) {
          backgroundTasks.setForeground(task.id, false);
          try {
            tracked.save();
          } catch (error) {
            backgroundTasks.setForeground(task.id, true);
            throw error;
          }
        }
        return { ...view, backgrounded: true };
      }),
    favoriteImportCancel: procedure
      .input(binding.extend({ token: z.string().uuid() }))
      .mutation(({ input: i }) => resolveStatus(i).favoriteEmojiImport.cancel(i.token)),
    favoriteImportDiscard: procedure
      .input(binding.extend({ token: z.string().uuid() }))
      .mutation(async ({ input: i }) => {
        await resolveStatus(i).favoriteEmojiImport.discard(i.token);
        return { discarded: true };
      }),
    favoriteExport: procedure
      .input(
        binding.extend({
          savePolicy: exportSavePolicyInput,
          includeIntegrityReport: z.boolean().optional(),
        }),
      )
      .mutation(({ input: i }) =>
        read(i, async (s) => {
          const current = () => {
            if (resolve(i) !== s) throw new Error('账号已改变，请重新导出');
          };
          if (!i.savePolicy.directory && !i.savePolicy.filePath)
            throw new Error('请先选择收藏包保存位置');
          return s.exportManager.startResourceExport({
            kind: 'favorite-emoji',
            resume: { type: 'favorite-emoji' },
            includeIntegrityReport: i.includeIntegrityReport,
            name: '收藏表情',
            output: { kind: 'file', name: '收藏表情', extension: 'zip' },
            savePolicy: i.savePolicy,
            run: (context) => runResumableExport(s, { type: 'favorite-emoji' }, context, current),
          });
        }),
      ),
    favoriteFromMedia: procedure
      .input(binding.extend({ url: z.string().min(1).max(16_384) }))
      .mutation(async ({ input: i }) => {
        const result: {
          emojiId: string;
          alreadyExists: boolean;
          existingPosition: number;
          local: PanelFavItem | null;
        } = {
          emojiId: '',
          alreadyExists: false,
          existingPosition: 0,
          local: null,
        };
        await write(i, async (s, current) => {
          const bytes = await readFavoriteEmojiMedia(i.url, current);
          current();
          const md5 = createHash('md5').update(bytes).digest('hex').toUpperCase();
          const ids = await s.emoji.fetchOnlineFavoriteIds();
          current();
          const existingIndex = ids.findIndex((id) => parseCustomFaceId(id).md5 === md5);
          const existingId = ids[existingIndex];
          const emojiId = existingId ?? (await s.emoji.addFavorite(bytes, undefined, current));
          current();
          if (!emojiId) throw new Error('未取得表情标识，请刷新表情列表核对结果');
          result.emojiId = emojiId;
          result.alreadyExists = existingId !== undefined;
          result.existingPosition = existingIndex + 1;
          result.local = await s.emoji.rememberFavorite(bytes);
          current();
        });
        return { ...accepted, ...result };
      }),
    favorite: procedure
      .input(
        binding.extend({
          action: z.enum(['add', 'delete', 'rename', 'move']),
          emojiId: id.optional(),
          path: id.optional(),
          desc: z.string().max(256).optional(),
          position: z.literal(1).optional(),
        }),
      )
      .mutation(async ({ input: i }) => {
        let addedEmojiId: string | undefined;
        const move = { submitted: false };
        const result = await write(i, async (s, current) => {
          if (i.action === 'add') {
            if (!i.path) throw new Error('请选择图片');
            addedEmojiId = await s.emoji.addFavorite(
              await image(s, i.path, current),
              undefined,
              current,
            );
            current();
            if (!addedEmojiId) throw new Error('未取得表情标识，请刷新收藏列表核对结果');
            return;
          }
          if (!i.emojiId) throw new Error('缺少收藏表情标识');
          if (i.action === 'delete') return s.emoji.deleteFavorite(i.emojiId);
          if (i.action === 'rename') return s.emoji.modifyFavoriteDesc(i.emojiId, i.desc ?? '');
          move.submitted = await s.emoji.moveFavorite(i.emojiId, i.position ?? 1, current);
        });
        return {
          ...result,
          ...(addedEmojiId ? { emojiId: addedEmojiId } : {}),
          ...(i.action === 'move' ? { moveSubmitted: move.submitted } : {}),
        };
      }),
    requests: procedure.input(groupInboxBinding).query(({ input }) =>
      read(
        input,
        async (s) =>
          (
            await loadRequestInbox(s, input.kind, {
              ...input,
              maxPages: input.cursor ? 1 : undefined,
            })
          ).operations,
      ),
    ),
    requestInbox: procedure.input(groupInboxQuery).query(async ({ input }) => {
      const inbox = await read(input, (s) =>
        loadRequestInbox(s, input.kind, { ...input, maxPages: input.cursor ? 1 : undefined }),
      );
      if (
        !input.cursor &&
        inbox.readSequence !== null &&
        (input.kind === 'group' || input.kind === 'filteredGroup')
      )
        confirmGroupNoticeRead?.(
          input,
          input.kind === 'group' ? 'normal' : 'filtered',
          inbox.readSequence,
        );
      return { ...inbox, canReportRead: input.kind === 'group' && canReportGroupNoticeRead() };
    }),
    reportGroupNoticeRead: procedure
      .input(binding.extend({ sequence: z.string().regex(/^[1-9]\d{0,19}$/) }))
      .mutation(async ({ input }) => {
        if (!canReportGroupNoticeRead()) return null;
        const sequence = BigInt(input.sequence);
        if (sequence > 0xffffffffffffffffn) return null;
        assertWritable?.(input);
        const services = resolve(input);
        const pid = services.accountConfig.getRecord()?.qqPid;
        const current = () => {
          assertWritable?.(input);
          if (
            !canReportGroupNoticeRead() ||
            resolve(input) !== services ||
            services.accountConfig.getRecord()?.qqPid !== pid
          )
            throw new Error('账号或 QQ 运行时已改变');
        };
        const confirmed = await services.groupNotify.reportNoticeRead(sequence, current);
        if (confirmed === undefined) return null;
        current();
        const readSequence = confirmed.toString();
        confirmGroupNoticeRead?.(input, 'normal', readSequence);
        return readSequence;
      }),
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
          if (!entry || entry.request.filtered !== (i.kind === 'filteredGroup'))
            throw new Error('申请已过期，请刷新');
          let request = entry.request;
          if (Date.now() >= entry.freshUntil || entry.pid !== s.accountConfig.getRecord()?.qqPid) {
            const { requests } = await s.groupNotify.fetchOnlineInbox({
              filtered: request.filtered,
              cursor: entry.cursor ? BigInt(entry.cursor) : undefined,
              maxPages: entry.cursor ? 1 : GROUP_INBOX_PAGE_LIMIT,
            });
            current();
            const refreshed = requests.find(
              (candidate) =>
                candidate.state === 1 &&
                candidate.filtered === request.filtered &&
                candidate.groupId === request.groupId &&
                candidate.eventType === request.eventType &&
                (candidate.rawSequence ?? candidate.sequence).toString() ===
                  (request.rawSequence ?? request.sequence).toString() &&
                (candidate.target.uid && request.target.uid
                  ? candidate.target.uid === request.target.uid
                  : candidate.target.uin > 0 && candidate.target.uin === request.target.uin),
            );
            if (!refreshed) {
              cache?.delete(i.token);
              throw new Error('这条申请已变化，请刷新群通知。');
            }
            request = refreshed;
          }
          cache?.delete(i.token);
          return s.groupNotify.handleOnlineRequest(request, i.approve, i.reason);
        }),
      ),
    todoLocalList: procedure.input(group).query(async ({ input: i }) => {
      const services = resolveStatus(i);
      const rows = await services.groupInfo.getGroupTodos(BigInt(i.groupId));
      if (resolveStatus(i) !== services) throw new Error('账号已切换，请刷新');
      return rows.map((todo) => ({
        sequence: todo.msgSeq.toString(),
        sourceId: `${todo.msgSeq}_${todo.msgRandom}`,
        text: todo.text,
        createdAt: todo.createTime,
        updatedAt: todo.updateTime,
        completed: false,
      }));
    }),
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
    groupJoinSettings: procedure
      .input(group)
      .query(({ input: i }) => read(i, (s) => s.groupInfo.getJoinInfo(i.groupId))),
    groupJoinManagement: procedure
      .input(group)
      .query(({ input: i }) => read(i, (s) => s.groupModeration.joinValidation(i.groupId))),
    verifyGroupJoinAnswer: procedure
      .input(group.extend({ question: z.string().max(256), answer: z.string().min(1).max(256) }))
      .mutation(async ({ input: i }) => {
        // 用 POST 传入待核对的答案，只返回是否匹配。
        const { option, question, answer } = await readManagedJoinSettings(i);
        return option === 4 && question === i.question && answer === i.answer;
      }),
    groupSettings: procedure
      .input(
        group.extend({
          action: z.enum(['leave', 'join', 'sign', 'addTag', 'deleteTag']),
          disband: z.boolean().optional(),
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
          if (i.action === 'leave') {
            const directory = await s.groupInfo.listGroupDirectory();
            const role = directory.find((row) => row.groupCode === String(i.groupId))?.role;
            current();
            if (role !== 'owner' && role !== 'admin' && role !== 'member')
              throw new Error('无法确认当前入群身份');
            if ((role === 'owner') !== (i.disband === true))
              throw new Error('请刷新群聊身份后重新确认操作');
            return s.groupModeration.leaveGroup(i.groupId);
          }
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
          const info = await s.groupInfo.getJoinInfo(i.groupId);
          current();
          if (info.groupId !== i.groupId || info.categoryId !== i.category)
            throw new Error('群分类未取得或已变化，请重新读取后再试');
          return i.action === 'addTag'
            ? s.groupModeration.addCategoryTag(i.category, i.tag)
            : s.groupModeration.deleteCategoryTag(i.category, i.tag);
        }),
      ),
    tags: procedure
      .input(binding.extend({ category: z.number().int().min(0).max(0xffffffff) }))
      .query(({ input: i }) => read(i, (s) => s.groupModeration.getCategoryTags(i.category))),
    groupSelectedTags: procedure
      .input(group)
      .query(({ input: i }) => read(i, (s) => s.groupModeration.getSelectedTags(i.groupId))),
    setGroupSelectedTags: procedure
      .input(
        group.extend({
          before: groupTags,
          tags: groupTags.refine(
            (tags) => tags.length <= GROUP_SELECTED_TAG_LIMIT,
            '群标签最多 20 个',
          ),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          await manager(s, i.groupId, current);
          const latest = await s.groupModeration.getSelectedTags(i.groupId);
          current();
          if (latest === null) throw new Error('暂未取得当前群的完整标签，请刷新后重试');
          if (sameGroupTags(latest, i.tags)) return;
          if (!sameGroupTags(latest, i.before))
            throw new Error('群标签已在其他端改变，请刷新后重新选择');
          return s.groupModeration.setSelectedTags(i.groupId, i.tags);
        }),
      ),
    qzoneHome: procedure
      .input(
        binding.extend({
          hostUin: z.string().regex(/^[1-9]\d{4,19}$/),
          cursor: z.string().max(65536).nullish(),
        }),
      )
      .query(({ input: i }) =>
        read(i, (s) => s.webQuery.qzoneHome(i.hostUin, i.cursor ?? undefined)),
      ),
    qzoneSpaceProfile: procedure
      .input(binding.extend({ hostUin: z.string().regex(/^[1-9]\d{4,19}$/) }))
      .query(({ input: i }) => read(i, (s) => s.webQuery.qzoneSpaceProfile(i.hostUin))),
    updateQzoneSpaceProfile: procedure
      .input(
        binding.extend({
          hostUin: z.string().regex(/^[1-9]\d{4,19}$/),
          name: z.string().max(80).optional(),
          description: z.string().max(512).optional(),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, (s, current) => s.webQuery.updateQzoneSpaceProfile(i.hostUin, i, current)),
      ),
    qzoneOrdinaryDetail: procedure
      .input(
        binding.extend({
          hostUin: z.string().regex(/^[1-9]\d{4,19}$/),
          tid: z.string().regex(/^[\da-f]{24}$/i),
        }),
      )
      .query(({ input: i }) => read(i, (s) => s.webQuery.qzoneOrdinaryDetail(i.hostUin, i.tid))),
    qzoneOrdinaryShare: procedure
      .input(
        binding.extend({
          hostUin: z.string().regex(/^[1-9]\d{4,19}$/),
          tid: z.string().regex(/^[\da-f]{24}$/i),
        }),
      )
      .mutation(({ input: i }) => read(i, (s) => s.webQuery.qzoneOrdinaryShare(i.hostUin, i.tid))),
    qzoneFeedShare: procedure
      .input(binding.extend({ feed: z.record(z.string(), z.unknown()) }))
      .mutation(({ input: i }) => read(i, (s) => s.webQuery.qzoneFeedShare(i.feed))),
    qzoneTextPostVisibility: procedure
      .input(qzoneTextPost)
      .query(({ input: i }) =>
        read(i, (s) => s.webQuery.qzoneTextPostVisibility(i.expectedAccountUin, i.tid)),
      ),
    updateQzoneTextPostVisibility: procedure
      .input(qzoneTextPost.extend({ expected: qzoneVisibility, visibility: qzoneVisibility }))
      .mutation(async ({ input: i }) => {
        let result: Awaited<
          ReturnType<QQActionServices['webQuery']['updateQzoneTextPostVisibility']>
        > = {
          state: 'unconfirmed',
        };
        await write(i, async (s, current) => {
          result = await s.webQuery.updateQzoneTextPostVisibility(
            i.expectedAccountUin,
            i.tid,
            i.expected,
            i.visibility,
            current,
          );
        });
        return result;
      }),
    removeQzonePost: procedure
      .input(
        binding.extend({
          hostUin: z.string().regex(/^[1-9]\d{4,19}$/),
          tid: z.string().regex(/^[\da-f]{24}$/i),
        }),
      )
      .mutation(async ({ input: i }) => {
        let confirmed = false;
        await write(i, async (s, current) => {
          confirmed = await s.webQuery.removeQzonePost(i.hostUin, i.tid, current);
        });
        return { state: confirmed ? ('confirmed' as const) : ('unconfirmed' as const) };
      }),
    qzone: procedure
      .input(
        binding.extend({
          hostUin: z.string().regex(/^[1-9]\d{4,19}$/),
          tid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          action: z.enum(['like', 'unlike', 'comment', 'reply']),
          replyTarget: z
            .object({
              rootId: z.string().regex(/^\d{1,20}$/),
              rootUin: z.string().regex(/^[1-9]\d{4,19}$/),
              uin: z.string().regex(/^[1-9]\d{4,19}$/),
              nickname: z.string().max(512),
            })
            .optional(),
          content: text.optional(),
          time: z.number().int().nonnegative().safe().default(0),
          imagePath: id.optional(),
          transferId: transferIdInput,
        }),
      )
      .mutation(({ input: i }) =>
        write(i, async (s, current) => {
          if (i.action === 'like' || i.action === 'unlike')
            return s.webQuery.setQzoneLike(i.hostUin, i.tid, i.action === 'like', i.time, current);
          if (!i.content) throw new Error('评论不能为空');
          if (i.action === 'comment' && i.replyTarget) throw new Error('回复不能作为一级评论提交');
          const content = i.content;
          return observeUpload(s, i.imagePath ? i.transferId : undefined, async (update) => {
            const upload = async (path: string) => {
              const data = await image(s, path, current);
              update({ phase: 'upload' });
              const picture = await s.webQuery.uploadQzoneImage(
                Buffer.from(data).toString('base64'),
                current,
              );
              current();
              update({ phase: 'confirming' });
              return picture.url;
            };
            if (i.action === 'reply') {
              const target = i.replyTarget;
              if (!target) throw new Error('请选择回复目标');
              const imageUrl = i.imagePath ? await upload(i.imagePath) : undefined;
              return s.webQuery.replyQzone(i.hostUin, i.tid, target, content, imageUrl, current);
            }
            if (!i.imagePath)
              return s.webQuery.commentQzone(
                i.hostUin,
                i.tid,
                content,
                undefined,
                undefined,
                current,
              );
            const imageUrl = await upload(i.imagePath);
            // 评论 richval 接受图片直链，不是发表说说的逗号分隔图片元数据。
            return s.webQuery.commentQzone(i.hostUin, i.tid, content, 1, imageUrl, current);
          });
        }),
      ),
    qzoneForward: procedure
      .input(
        binding.extend({
          hostUin: z.string().regex(/^[1-9]\d{4,19}$/),
          tid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          reason: z.string().max(4096),
        }),
      )
      .mutation(({ input: i }) =>
        write(i, (s, current) => s.webQuery.forwardQzone(i.hostUin, i.tid, i.reason, current)),
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
