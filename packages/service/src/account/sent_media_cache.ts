import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { cleanNtLocalPath, isHttpUrl, type MediaSource } from '@weqbot/protocol';
import { writeFileAtomic } from '../common/atomic_write';

const digestPattern = /^[a-f0-9]{32}$/i;
const bodyNamePattern = /^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/;
const abandonedAge = 24 * 60 * 60 * 1000;
const extensions = { pic: '', video: '.mp4', ptt: '.silk', file: '' } as const;
export type SentMediaKind = keyof typeof extensions;

export interface StagedSentMedia {
  path: string;
  publish(
    kind: SentMediaKind,
    md5: string,
    tokens?: readonly string[],
    name?: string,
  ): Promise<void>;
  discard(): Promise<void>;
}

function key(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function processStillExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function linkUnavailable(error: NodeJS.ErrnoException) {
  return ['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(error.code ?? '');
}

/** 已发媒体按账号、类型和上传指纹存放，凭据索引只记录哈希。 */
export class SentMediaCache {
  private readonly root: string;
  private cleanupStarted = false;

  constructor(cacheDir: string, accountId: string) {
    this.root = join(cacheDir, 'sent', key(accountId));
  }

  private body(kind: SentMediaKind, md5: string) {
    return join(this.root, kind, `${md5.toLowerCase()}${extensions[kind]}`);
  }

  private ref(kind: SentMediaKind, token: string, name?: string) {
    const identity = kind === 'file' ? JSON.stringify([token, name]) : token;
    return join(this.root, 'refs', kind, key(identity));
  }

  find(kind: SentMediaKind, token: string, md5 = '', fileName?: string): string | null {
    // 图片消息落库后，QQ 可能换一个下载凭据，内容指纹仍可直接定位。
    if (digestPattern.test(md5)) {
      const path = this.body(kind, md5);
      if (existsSync(path)) return path;
    }
    if (!token) return null;
    try {
      const name = readFileSync(this.ref(kind, token, fileName), 'utf8');
      if (!bodyNamePattern.test(name)) return null;
      const path = join(this.root, kind, name);
      return existsSync(path) ? path : null;
    } catch {
      return null;
    }
  }

  private async clearAbandoned(root: string) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      const owner = /^(\d+)-[a-f0-9-]{36}$/.exec(entry.name);
      if (!entry.isDirectory() || !owner || processStillExists(Number(owner[1]))) continue;
      const path = join(root, entry.name);
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > abandonedAge)
        await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }

  async stage(source: MediaSource, stagedByWeQ = false): Promise<StagedSentMedia | undefined> {
    const file = typeof source === 'string' ? cleanNtLocalPath(source) : '';
    if (typeof source === 'string' && (!file || isHttpUrl(file))) return;
    const pending = join(this.root, 'pending');
    if (!this.cleanupStarted) {
      this.cleanupStarted = true;
      void this.clearAbandoned(pending);
    }
    const directory = join(pending, `${process.pid}-${randomUUID()}`);
    const path = join(directory, file ? basename(file) : 'media');
    const discard = () => rm(directory, { recursive: true, force: true }).catch(() => {});
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (typeof source === 'string') {
        if (stagedByWeQ) {
          // 宿主暂存仍由上传租期保护；同卷时保留同一个 inode。
          try {
            await link(file, path);
          } catch (error) {
            if (!linkUnavailable(error as NodeJS.ErrnoException)) throw error;
            await copyFile(file, path, constants.COPYFILE_FICLONE);
          }
        } else {
          // 用户原件仍可编辑，上传与缓存都使用同一份快照。
          await copyFile(file, path, constants.COPYFILE_FICLONE);
        }
      } else {
        await writeFile(path, source, { flag: 'wx', mode: 0o600 });
      }
    } catch (error) {
      await discard();
      throw error;
    }
    return {
      path,
      publish: async (kind, md5, tokens = [], name) => {
        if (!digestPattern.test(md5)) return;
        const ext = kind === 'file' && name ? extname(name).toLowerCase() : extensions[kind];
        const filename = `${md5.toLowerCase()}${/^\.[a-z0-9]{1,16}$/.test(ext) ? ext : ''}`;
        const body = join(this.root, kind, filename);
        await mkdir(join(this.root, kind), { recursive: true, mode: 0o700 });
        await link(path, body).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') return;
          if (!linkUnavailable(error)) throw error;
          if (!existsSync(body)) await rename(path, body);
        });
        for (const token of new Set(tokens))
          if (token) await writeFileAtomic(this.ref(kind, token, name), filename);
      },
      discard,
    };
  }
}
