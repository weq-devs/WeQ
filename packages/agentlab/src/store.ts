import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentLabPersona, AgentLabStoredPair } from './types';

export interface StoredPersonaRecord {
  persona: AgentLabPersona;
  pairs: AgentLabStoredPair[];
}

export const AGENTLAB_PERSONA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertPersonaId(id: string): void {
  if (typeof id !== 'string' || !AGENTLAB_PERSONA_ID_PATTERN.test(id))
    throw new Error('克隆 ID 无效：仅允许字母、数字、下划线和连字符，最长 128 字符。');
}

export class AgentLabStore {
  private readonly root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  listPersonas(): AgentLabPersona[] {
    const out: AgentLabPersona[] = [];
    for (const file of this.safeFiles()) {
      const id = file.slice(0, -5);
      if (!AGENTLAB_PERSONA_ID_PATTERN.test(id)) continue;
      // 列表不跟随链接；真实读取仍会显式诊断坏文件。
      if (!lstatSync(join(this.root, file)).isFile()) continue;
      const record = this.readPersona(id, true);
      if (record?.persona) out.push(record.persona);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getPersona(personaId: string): StoredPersonaRecord | null {
    return this.readPersona(personaId, false);
  }

  private readPersona(personaId: string, listing: boolean): StoredPersonaRecord | null {
    const path = this.recordPath(personaId);
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const record = JSON.parse(readFileSync(fd, 'utf-8')) as StoredPersonaRecord;
      // 同目录还存会话、记忆、助手配置等 JSON；枚举时不能把它们当作损坏的克隆体。
      if (listing && (!record || typeof record !== 'object' || !Object.hasOwn(record, 'persona')))
        return null;
      if (!record?.persona || record.persona.id !== personaId || !Array.isArray(record.pairs))
        throw new Error('记录结构或 ID 不匹配');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`读取克隆 ${personaId} 失败，原文件已保留。`, { cause: error });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  savePersona(record: StoredPersonaRecord): void {
    const path = this.recordPath(record.persona.id);
    // 已有损坏文件不作为空库覆盖；用户可先恢复/移走原件，再显式重建。
    this.getPersona(record.persona.id);
    const tmp = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(record, null, 2), 'utf-8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(tmp, { force: true });
    }
  }

  deletePersona(personaId: string): boolean {
    const path = this.recordPath(personaId);
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private safeFiles(): string[] {
    try {
      return readdirSync(this.root).filter((file) => file.endsWith('.json'));
    } catch (error) {
      throw new Error('无法列出克隆记录，原目录已保留。', { cause: error });
    }
  }

  private recordPath(id: string): string {
    assertPersonaId(id);
    if (realpathSync(this.root) !== this.root) throw new Error('克隆根目录已变化');
    const path = resolve(this.root, `${id}.json`);
    if (dirname(path) !== this.root) throw new Error('克隆路径越界');
    try {
      if (!lstatSync(path).isFile())
        throw new Error('克隆记录必须是普通文件，不能是符号链接或目录');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return path;
  }
}
