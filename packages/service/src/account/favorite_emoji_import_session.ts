import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCustomFaceId } from '@weq/protocol';
import {
  readEmojiImportArchive,
  planFavoriteEmojiImport,
  type FavoriteEmojiBundleItem,
  type FavoriteEmojiImportDisposition,
} from './favorite_emoji_bundle';
import {
  runFavoriteEmojiImport,
  type FavoriteEmojiImportPort,
  type FavoriteEmojiImportResult,
} from './favorite_emoji_import';

export const FAVORITE_EMOJI_PREVIEW_TTL_MS = 10 * 60_000;
export interface FavoriteEmojiImportPreview {
  token: string;
  phase: 'ready' | 'running' | 'finished' | 'expired';
  expiresAt: number;
  cancelling: boolean;
  error: string | null;
  result: FavoriteEmojiImportResult | null;
  items: Array<{
    key: string;
    description: string;
    position: number;
    disposition: FavoriteEmojiImportDisposition;
    issue: string | null;
    previewPath: string | null;
    byteLength: number;
  }>;
}
interface Session {
  view: FavoriteEmojiImportPreview;
  items: FavoriteEmojiBundleItem[];
  current: () => void;
  abort: AbortController;
  directory: string;
  paths: Set<string>;
  work: Promise<void> | null;
}

/** 每个账号只有一份短期预览；不是可重试或可续作的写任务队列。 */
export class FavoriteEmojiImportSession {
  private session: Session | null = null;
  private preparing = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emoji: FavoriteEmojiImportPort,
    private readonly files: { trustPath(path: string): void; untrustPath(path: string): void },
  ) {}

  private check(session?: Session) {
    if (this.disposed) throw new Error('账号已关闭，收藏导入已停止');
    session?.current();
  }

  async prepare(
    archive: Buffer | (() => Promise<Buffer>),
    current: () => void,
  ): Promise<FavoriteEmojiImportPreview> {
    this.check();
    if (this.preparing || this.session?.view.phase === 'running')
      throw new Error('请等待当前收藏导入操作结束');
    this.preparing = true;
    let directory: string | null = null;
    try {
      await this.discard();
      this.check();
      current();
      const bytes = typeof archive === 'function' ? await archive() : archive;
      this.check();
      current();
      const items = readEmojiImportArchive(bytes);
      const ids = await this.emoji.fetchOnlineFavoriteIds();
      this.check();
      current();
      const plan = planFavoriteEmojiImport(
        items,
        ids.map((id) => parseCustomFaceId(id).md5),
      );
      directory = await mkdtemp(join(tmpdir(), 'weq-favorite-import-'));
      const session: Session = {
        view: {
          token: randomUUID(),
          phase: 'ready',
          expiresAt: Date.now() + FAVORITE_EMOJI_PREVIEW_TTL_MS,
          cancelling: false,
          error: null,
          result: null,
          items: [],
        },
        items,
        current,
        abort: new AbortController(),
        directory,
        paths: new Set(),
        work: null,
      };
      for (const item of plan) {
        this.check(session);
        const path = item.image
          ? join(directory, `${item.image.sha256}${item.image.extension}`)
          : null;
        if (path && !session.paths.has(path)) {
          await writeFile(path, item.image!.bytes, { flag: 'wx', mode: 0o600 });
          this.check(session);
          session.paths.add(path);
        }
        session.view.items.push({
          key: item.key,
          description: item.description,
          position: item.position,
          disposition: item.disposition,
          issue: item.issue,
          previewPath: path,
          byteLength: item.image?.byteLength ?? 0,
        });
      }
      this.check(session);
      for (const path of session.paths) this.files.trustPath(path);
      this.session = session;
      directory = null;
      this.armExpiry(session);
      return structuredClone(session.view);
    } finally {
      this.preparing = false;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  read(): FavoriteEmojiImportPreview | null {
    const session = this.session;
    if (!session || this.disposed) return null;
    if (session.view.phase === 'ready' || session.view.phase === 'running') {
      try {
        this.check(session);
      } catch (error) {
        this.invalidate(session, this.message(error));
      }
    }
    return structuredClone(session.view);
  }

  start(
    token: string,
    keys: readonly string[],
    exclusive: (
      run: () => Promise<FavoriteEmojiImportResult>,
    ) => Promise<FavoriteEmojiImportResult>,
  ): FavoriteEmojiImportPreview {
    const session = this.require(token);
    if (session.view.phase !== 'ready') throw new Error('此收藏包已提交或过期，请重新选择文件');
    const selected = new Set(keys);
    if (
      !keys.length ||
      selected.size !== keys.length ||
      keys.some(
        (key) =>
          !session.view.items.some((item) => item.key === key && item.disposition === 'ready'),
      )
    )
      throw new Error('请选择可导入且不重复的表情');
    const snapshot = [...keys];
    session.view.phase = 'running';
    // 先消耗令牌再启动异步写入；响应丢失后重新查询，不允许同一令牌二次上传。
    session.work = (async () => {
      try {
        session.view.result = await exclusive(() =>
          runFavoriteEmojiImport(session.items, snapshot, this.emoji, {
            current: () => this.check(session),
            signal: session.abort.signal,
            progress: (result) => {
              session.view.result = result;
            },
          }),
        );
      } catch (error) {
        session.view.error = this.message(error);
      } finally {
        session.items = [];
        session.view.phase = 'finished';
        session.view.expiresAt = Date.now() + FAVORITE_EMOJI_PREVIEW_TTL_MS;
        if (!this.disposed) this.armExpiry(session);
      }
    })();
    return structuredClone(session.view);
  }

  cancel(token: string): FavoriteEmojiImportPreview {
    const session = this.require(token, false);
    if (session.view.phase === 'running') {
      session.view.cancelling = true;
      session.abort.abort();
    } else this.invalidate(session, '已取消本次导入预览');
    return structuredClone(session.view);
  }

  async discard(token?: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (token && session.view.token !== token) throw new Error('收藏预览已改变，请刷新');
    if (session.view.phase === 'running') throw new Error('请先停止导入并等待在途请求结束');
    this.session = null;
    this.clearTimer();
    await this.release(session);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.abort.abort();
    if (session.work) await session.work;
    await this.release(session);
  }

  private require(token: string, check = true) {
    const session = this.session;
    if (!session || session.view.token !== token) throw new Error('收藏预览已过期，请重新选择文件');
    if (check) this.check(session);
    if (Date.now() >= session.view.expiresAt) this.invalidate(session, '收藏预览已过期');
    return session;
  }
  private invalidate(session: Session, reason: string) {
    session.view.error = reason;
    session.abort.abort();
    if (session.view.phase === 'running') session.view.cancelling = true;
    else {
      session.view.phase = 'expired';
      void this.release(session);
    }
  }
  private async release(session: Session) {
    session.items = [];
    for (const path of session.paths) this.files.untrustPath(path);
    session.paths.clear();
    for (const item of session.view.items) item.previewPath = null;
    await rm(session.directory, { recursive: true, force: true }).catch(() => {});
  }
  private armExpiry(session: Session) {
    this.clearTimer();
    this.timer = setTimeout(
      () => {
        if (this.session !== session) return;
        this.invalidate(session, '收藏预览已过期');
        if (session.view.phase !== 'running') this.session = null;
      },
      Math.max(0, session.view.expiresAt - Date.now()),
    );
    this.timer.unref();
  }
  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private message(error: unknown) {
    return (error instanceof Error ? error.message : '收藏导入失败').slice(0, 512);
  }
}
