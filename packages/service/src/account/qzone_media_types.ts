import { setTimeout as delay } from 'node:timers/promises';
import {
  GetQzoneFeedMediaDetail,
  type QzoneNativeDetail,
  type QzoneMediaType,
  type TrpcNative,
  SetQzoneFeedStatus,
  type QzoneArchiveAction,
} from '@weq/protocol';
import { getLogger } from '../common/logger';
import { projectQzoneArchive } from '../common/qzone_archive';

const logger = getLogger().child({ scope: 'qzone-archive' });

export class QzoneMediaTypesService {
  private readonly cache = new Map<string, { expires: number; values: QzoneNativeDetail | null }>();
  private readonly pending = new Map<string, Promise<QzoneNativeDetail>>();

  constructor(
    private readonly nt: TrpcNative,
    private readonly resolvePid: () => number,
  ) {}

  async read(
    params: GetQzoneFeedMediaDetail.Params,
    signal?: AbortSignal,
  ): Promise<QzoneMediaType[]> {
    return (await this.readDetail(params, signal)).mediaTypes;
  }
  async readDetail(
    params: GetQzoneFeedMediaDetail.Params,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<QzoneNativeDetail> {
    signal?.throwIfAborted();
    const pid = this.resolvePid();
    const key = JSON.stringify([pid, params.ownerUin, params.tid, params.time]);
    if (refresh) {
      // 写后核对不能复用写入前仍在途的详情。
      await this.pending.get(key)?.catch(() => {});
      signal?.throwIfAborted();
      if (this.resolvePid() !== pid) throw new Error('QQ 会话已切换。');
      this.cache.delete(key);
    }
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      if (!cached.values) throw new Error('空间媒体类型暂时不可用。');
      return this.copy(cached.values);
    }
    let task = this.pending.get(key);
    if (!task) {
      if (this.pending.size >= 2) throw new Error('空间媒体类型正在读取。');
      task = GetQzoneFeedMediaDetail.invokeDetail(this.nt, pid, params)
        .then((values) => {
          if (this.resolvePid() !== pid) throw new Error('QQ 会话已切换。');
          this.remember(key, values, 5 * 60_000);
          return values;
        })
        .catch((error: unknown) => {
          this.remember(key, null, 30_000);
          throw error;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, task);
    }
    const values = await task;
    signal?.throwIfAborted();
    if (this.resolvePid() !== pid) throw new Error('QQ 会话已切换。');
    return this.copy(values);
  }
  async setArchive(
    params: GetQzoneFeedMediaDetail.Params,
    selfUin: string,
    action: QzoneArchiveAction,
    beforeSend: () => void,
    signal?: AbortSignal,
  ) {
    if (params.ownerUin !== selfUin) throw new Error('只能管理自己的说说。');
    const detail = await this.readDetail(params, signal, true);
    const view = projectQzoneArchive(detail, true);
    const allowed =
      action === 'contribute'
        ? view.canContribute
        : action === 'uncontribute'
          ? view.canUncontribute
          : view.canUnarchive;
    if (!allowed || !detail.archiveTarget)
      throw new Error('当前说说不支持此状态操作，请刷新后重试。');
    signal?.throwIfAborted();
    const pid = this.resolvePid();
    beforeSend();
    const accepted = await SetQzoneFeedStatus.invoke(this.nt, pid, {
      feedId: detail.archiveTarget.feedId,
      selfUin,
      action,
    });
    const expectedStatus = action === 'contribute' ? 101 : action === 'uncontribute' ? 0 : 4;
    let readback: QzoneNativeDetail | null = null;
    const observed: (number | 'missing' | 'read-failed')[] = [];
    const started = performance.now();
    // 投稿回执可先于详情更新；只补读，不能重发写入。
    for (const waitMs of [0, 500, 1500]) {
      if (waitMs) {
        if (performance.now() - started + waitMs > 5000) break;
        await delay(waitMs, undefined, { signal });
      }
      signal?.throwIfAborted();
      if (this.resolvePid() !== pid) throw new Error('操作已提交，QQ 会话已切换，暂未确认结果。');
      readback = await this.readDetail(params, signal, true).catch(() => null);
      signal?.throwIfAborted();
      const status = readback?.archive?.rawStatus;
      if (status === expectedStatus || (action === 'contribute' && status === 102))
        return { ...accepted, expectedStatus, confirmed: true, detail: readback };
      observed.push(status ?? (readback ? 'missing' : 'read-failed'));
    }
    logger.warn('空间操作已受理，未从详情确认状态', { action, expectedStatus, observed });
    return { ...accepted, expectedStatus, confirmed: false, detail: readback };
  }
  private copy(value: QzoneNativeDetail): QzoneNativeDetail {
    return {
      ...value,
      mediaTypes: value.mediaTypes.map((media) => ({ ...media })),
      ...(value.archive
        ? {
            archive: { ...value.archive, tag: value.archive.tag ? { ...value.archive.tag } : null },
          }
        : {}),
      ...(value.archiveTarget
        ? {
            archiveTarget: {
              ...value.archiveTarget,
              mediaKinds: [...value.archiveTarget.mediaKinds],
            },
          }
        : {}),
      ...(value.upvote
        ? { upvote: { ...value.upvote, users: value.upvote.users.map((user) => ({ ...user })) } }
        : {}),
    };
  }
  private remember(key: string, values: QzoneNativeDetail | null, ttl: number) {
    this.cache.delete(key);
    this.cache.set(key, { values, expires: Date.now() + ttl });
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
  }
}
