/**
 * bot 侧 AgentLabStore 的 persona 读穿缓存。
 *
 * 背景：runtime 的私聊 / 群聊 / 记忆蒸馏路径每条消息都要 getPersona，父类实现是
 * 全量 readFileSync + JSON.parse；persona 记录内嵌训练语料 pairs，克隆语料大时
 * （数 MB 的 <id>.json）这是每条消息固定的同步磁盘读 + 解析开销。bot 进程内
 * persona 的写入方只有 boot 的语音参考路径回填与 WebUI 的表情增删（都经 savePersona），
 * 运行期基本只读，适合按文件状态做失效。
 *
 * 缓存策略：
 * - 失效键 = (mtimeMs, size)：stat 一致 → 直接返回缓存记录；不一致或 stat 失败 →
 *   回落父类全量读取（O_NOFOLLOW 安全路径）。
 * - 全量读取前后各 stat 一次，不一致（读取撞上外部写入）则本次不入缓存，
 *   避免缓存到半新半旧的组合。
 * - 入缓存的记录深冻结：bot 全链路（runtime / webui / boot）对 getPersona 结果只读，
 *   冻结把「未来代码原地改写共享缓存」从静默污染变成显式 TypeError。未入缓存的
 *   回落返回值保持父类语义（新鲜可变对象），调用方对两者都应当只读。
 * - listPersonas 不缓存：仍返回新鲜可变对象（boot 的 refClips 路径回填依赖可写）。
 * - savePersona / deletePersona 后失效对应条目；父类写失败抛错时缓存不动，与磁盘一致。
 *
 * 安全边界：
 * - 命中路径的 statSync 跟随符号链接但不读文件内容，真实读取永远走父类的
 *   O_NOFOLLOW 路径：换成符号链接要么 miss 后被父类拒绝，要么命中返回旧缓存，
 *   都不会读到链接目标的新内容。
 * - 非法 id 跳过缓存，交父类 assertPersonaId 统一报错；pattern 只允许
 *   [A-Za-z0-9_-]，拼接路径不可能越界。
 * - 不覆盖的极端情况：外部改写后 mtimeMs 与 size 都恰好不变则不被感知
 *   （返回旧记录）。进程内写入都经 savePersona 失效，不受此限。
 */
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTLAB_PERSONA_ID_PATTERN, AgentLabStore } from '@weq/agentlab';

type PersonaRecord = NonNullable<ReturnType<AgentLabStore['getPersona']>>;

interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface CacheEntry extends FileStamp {
  record: PersonaRecord;
}

/**
 * 迭代深冻结（就地）。JSON 解析/序列化过的数据无环状引用，无需 visited 集合；
 * 已冻结子树直接跳过，重复调用幂等。
 */
function freezeDeep<V>(value: V): V {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || typeof cur !== 'object' || Object.isFrozen(cur)) continue;
    Object.freeze(cur);
    for (const child of Object.values(cur as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
  return value;
}

export class CachedAgentLabStore extends AgentLabStore {
  private readonly cacheRoot: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(root: string) {
    super(root);
    this.cacheRoot = realpathSync(root);
  }

  /** 缓存只处理合法 id；非法 id 返回 null 走父类统一报错。 */
  private cachePath(personaId: string): string | null {
    if (typeof personaId !== 'string' || !AGENTLAB_PERSONA_ID_PATTERN.test(personaId)) return null;
    return join(this.cacheRoot, `${personaId}.json`);
  }

  private stampOf(path: string): FileStamp | null {
    try {
      const st = statSync(path);
      return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
    } catch {
      return null;
    }
  }

  override getPersona(personaId: string): PersonaRecord | null {
    const path = this.cachePath(personaId);
    if (!path) return super.getPersona(personaId);

    const hit = this.cache.get(personaId);
    if (hit) {
      const st = this.stampOf(path);
      if (st && st.mtimeMs === hit.mtimeMs && st.size === hit.size) return hit.record;
      this.cache.delete(personaId);
    }

    const before = this.stampOf(path);
    const record = super.getPersona(personaId);
    if (!record) return null;
    const after = this.stampOf(path);
    // 读取前后文件状态一致才入缓存；撞上写入就放弃本次缓存，下次读取重试。
    if (before && after && before.mtimeMs === after.mtimeMs && before.size === after.size) {
      this.cache.set(personaId, { ...after, record: freezeDeep(record) });
    }
    return record;
  }

  override savePersona(record: PersonaRecord): void {
    super.savePersona(record);
    this.cache.delete(record.persona.id);
  }

  override deletePersona(personaId: string): boolean {
    this.cache.delete(personaId);
    return super.deletePersona(personaId);
  }
}
