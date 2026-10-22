import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import {
  isWeqBackupConfigId,
  parseWeqBackupJson,
  weqBackupPart,
  validateWeqCloneAsset,
  WEQ_BACKUP_LIMITS,
  type WeqBackupFile,
} from './backup_bundle';
import { weqCloneStickerReferences, weqClonePersona } from './backup_refs';

export interface CloneBackupSnapshot {
  files: WeqBackupFile[];
  warnings: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 只读取普通文件；配置根目录本身由调用方解析，不从克隆文件内推导目录。 */
export function readWeqBackupFile(
  path: string,
  maxBytes = WEQ_BACKUP_LIMITS.maxEntryBytes,
): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('克隆资产不是普通文件');
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('克隆资产不是普通文件');
    if (stat.size > maxBytes) throw new Error('备份文件体积超过限制');
    // 读入边界以内的文件，再用同一 fd 确认没有读到被截断或扩大的内容。
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    const data = buffer.subarray(0, size);
    if (data.length !== stat.size || data.length > maxBytes)
      throw new Error('克隆资产在备份期间发生变化，请重试');
    return data;
  } finally {
    closeSync(fd);
  }
}

function directoryEntries(path: string): string[] {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('克隆数据目录不是普通目录');
    return readdirSync(path).sort();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * 克隆 persona 的资产引用沿用机器人导出的相对路径约定。这里同时保留会话／记忆等
 * JSON Store 与 agentvoice，不能用单 persona 的机器人导出替代整份用户数据备份。
 */
export function snapshotWeqClones(
  agentlabRoot: string,
  configIds?: readonly string[],
): CloneBackupSnapshot {
  const root = resolve(agentlabRoot);
  const scopes = configIds
    ? [...new Set(configIds)]
    : directoryEntries(root).filter(isWeqBackupConfigId);
  const files = new Map<string, WeqBackupFile>();
  const warnings: string[] = [];
  let bytes = 0;
  const add = (path: string, data: Buffer) => {
    weqBackupPart(path);
    const key = path.normalize('NFC').toLowerCase();
    const previous = files.get(key);
    if (previous) {
      if (previous.path !== path || !previous.data.equals(data))
        throw new Error('克隆备份路径存在不同内容冲突');
      return;
    }
    if (files.size + 2 > WEQ_BACKUP_LIMITS.maxEntries) throw new Error('克隆备份文件数量超过限制');
    bytes += data.length;
    if (bytes > WEQ_BACKUP_LIMITS.maxTotalBytes)
      throw new Error('克隆数据超过 256 MiB，请分批备份');
    files.set(key, { path, data });
  };

  for (const scope of scopes) {
    if (!isWeqBackupConfigId(scope)) throw new Error('无效的克隆账号配置标识');
    const directory = join(root, scope);
    const names = directoryEntries(directory);
    const prefix = `clones/${scope}`;
    const assetCache = new Map<string, string | null>();
    for (const name of names) {
      // bot_exports 是当前机器生成的机器人运行入口，包含过期地址／密钥，不是克隆数据。
      if (!name.endsWith('.json') || name === 'bot_exports.json') continue;
      const path = `${prefix}/${name}`;
      weqBackupPart(path);
      const data = readWeqBackupFile(join(directory, name));
      const value = parseWeqBackupJson(data);
      if (!record(value)) {
        add(path, data);
        continue;
      }
      const persona = weqClonePersona(value, name) ?? {};
      const stickers = weqCloneStickerReferences(value, name);
      const hasVoice =
        record(persona.voiceProfile) &&
        Array.isArray(persona.voiceProfile.refClips) &&
        persona.voiceProfile.refClips.length > 0;
      if (!stickers.length && !hasVoice) {
        add(path, data);
        continue;
      }
      const asset = (source: string, kind: 'stickers' | 'voice'): string | null => {
        const sourcePath = resolve(directory, source);
        const key = `${kind}\0${sourcePath}`;
        if (assetCache.has(key)) return assetCache.get(key) ?? null;
        let content: Buffer;
        try {
          content = readWeqBackupFile(sourcePath);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            warnings.push(`${scope}/${name} 有缺失的${kind === 'voice' ? '参考语音' : '表情'}资产`);
            assetCache.set(key, null);
            return null;
          }
          throw error;
        }
        const hash = createHash('sha256').update(content).digest('hex');
        let portable = relative(directory, sourcePath).split('\\').join('/');
        try {
          if (!portable.startsWith(`${kind}/`)) throw new Error('外部资产');
          weqBackupPart(`${prefix}/${portable}`);
        } catch {
          let extension = 'png';
          if (kind === 'voice') {
            extension = content.toString('ascii', 0, 4) === 'RIFF' ? 'wav' : 'mp3';
          }
          portable = `${kind}/${hash}.${extension}`;
        }
        validateWeqCloneAsset(`${prefix}/${portable}`, content);
        add(`${prefix}/${portable}`, content);
        assetCache.set(key, portable);
        return portable;
      };
      for (const sticker of stickers) {
        const source =
          typeof sticker.localPath === 'string' && sticker.localPath
            ? sticker.localPath
            : typeof sticker.md5 === 'string' && /^[0-9a-f]{1,64}$/i.test(sticker.md5)
              ? `stickers/${sticker.md5}.png`
              : null;
        if (!source) continue;
        const portable = asset(source, 'stickers');
        if (portable) sticker.localPath = portable;
        else delete sticker.localPath;
      }
      if (record(persona.voiceProfile) && Array.isArray(persona.voiceProfile.refClips)) {
        const retained: unknown[] = [];
        for (const clip of persona.voiceProfile.refClips) {
          if (!record(clip) || typeof clip.path !== 'string')
            throw new Error('克隆参考语音引用结构无效');
          const portable = asset(clip.path, 'voice');
          const missing = `voice/${createHash('sha256').update(clip.path).digest('hex')}.wav`;
          retained.push({ ...clip, path: portable ?? missing });
        }
        persona.voiceProfile.refClips = retained;
      }
      add(path, Buffer.from(JSON.stringify(value)));
    }
    for (const kind of ['stickers', 'voice', 'agentvoice', 'assistant_runs', 'reports']) {
      for (const name of directoryEntries(join(directory, kind))) {
        const path = `${prefix}/${kind}/${name}`;
        // 不收集模型、未知资源或目录中的数据库；只保留实际运行时可寻址的资产。
        try {
          weqBackupPart(path);
        } catch {
          warnings.push(`${scope}/${kind} 中有未纳入备份的非克隆资产`);
          continue;
        }
        if (assetCache.has(`${kind}\0${resolve(directory, kind, name)}`)) continue;
        const content = readWeqBackupFile(join(directory, kind, name));
        if (kind === 'stickers' || kind === 'voice' || kind === 'agentvoice')
          validateWeqCloneAsset(path, content);
        add(path, content);
      }
    }
  }
  return { files: [...files.values()], warnings: [...new Set(warnings)] };
}

/** 恢复前定位到当前机器的克隆根；禁止相对引用越出所选账号的数据域。 */
export function relocateWeqCloneAssets(file: WeqBackupFile, agentlabRoot: string): WeqBackupFile {
  if (weqBackupPart(file.path) !== 'clones' || !file.path.endsWith('.json')) return file;
  const value = parseWeqBackupJson(file.data);
  if (!record(value)) return file;
  const persona = weqClonePersona(value, file.path.split('/')[2]!) ?? {};
  const stickers = weqCloneStickerReferences(value, file.path.split('/')[2]!);
  const hasVoice =
    record(persona.voiceProfile) &&
    Array.isArray(persona.voiceProfile.refClips) &&
    persona.voiceProfile.refClips.length > 0;
  if (!stickers.length && !hasVoice) return file;
  const scope = file.path.split('/')[1]!;
  const root = resolve(agentlabRoot, scope);
  const absolute = (path: string, kind: 'stickers' | 'voice') => {
    const expected = `clones/${scope}/${path}`;
    if (!path.startsWith(`${kind}/`) || weqBackupPart(expected) !== 'clones')
      throw new Error('克隆备份中的资产引用不是包内相对路径');
    return resolve(root, path);
  };
  for (const sticker of stickers) {
    if (sticker.localPath !== undefined) {
      if (typeof sticker.localPath !== 'string') throw new Error('克隆表情路径无效');
      sticker.localPath = absolute(sticker.localPath, 'stickers');
    }
  }
  if (record(persona.voiceProfile) && Array.isArray(persona.voiceProfile.refClips)) {
    for (const clip of persona.voiceProfile.refClips) {
      if (!record(clip) || typeof clip.path !== 'string')
        throw new Error('克隆参考语音引用结构无效');
      clip.path = absolute(clip.path, 'voice');
    }
  }
  return { path: file.path, data: Buffer.from(JSON.stringify(value)) };
}
