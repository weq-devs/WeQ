/**
 * 通用 JSON 文件读写 —— 消除各 account/ 服务里手写的「load-on-construct + 变更即写」
 * 样板（deleted_msgs / anti_recall / agentlab_* / assistant … 每份都复制了一份
 * `existsSync → readFileSync → JSON.parse → try/catch 回落`）。
 *
 * 统一约定（与既有各 store 的行为逐一对齐）：
 *  - 缺失 → `makeInitial()`；损坏/读取失败默认回落但阻止覆盖原件，strict 模式抛错。
 *  - 写用原子写（.tmp + rename，见 {@link writeFileAtomicSync}），写完永远是一个完整
 *    文件；缓存默认宽容写失败，strict 权威数据则必须抛错阻断业务。
 *
 * 用法：
 *   - 整文件「记住一个东西」的 store：new JsonStore(filePath, makeInitial, opts)，
 *     之后读写 `store.data`，变更完调 `store.save()`。
 *   - 只想复用「读不抛错 / 原子写」的函数式模块（如 desktop 的缓存快照）：
 *     {@link readJsonFile} + {@link writeJsonFileAtomic}。
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic_write';

/** {@link JsonStore} 的构造选项。 */
export interface JsonStoreOptions<T> {
  /** 权威数据：读取损坏或写盘失败必须抛错。 */
  strict?: boolean;
  /** 读入的原始值 → 期望形状。缺省 = 原样透传（依赖调用方会校验的类型）。 */
  normalize?: (raw: unknown) => T;
  /** 落盘时 pretty-print（`JSON.stringify(data, null, 2)`）。缺省紧凑。 */
  pretty?: boolean;
}

/** 读一个 UTF-8 JSON 文件；缺失 / 损坏 / 不是 JSON 一律返回 null（不抛）。 */
export function readJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

/** 原子写一个 JSON 文件（UTF-8，懒建父目录）；失败静默。 */
export function writeJsonFileAtomic(path: string, data: unknown, pretty = false): void {
  try {
    writeFileAtomicSync(path, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  } catch {
    /* 持久化失败不应影响业务主流程 */
  }
}

/**
 * 整文件 JSON 存储：构造时同步读盘一次，之后所有读写走内存，`save()` 原子落盘。
 * `data` 公开可变 —— 调用方按自己的业务方法改它，改完调用 {@link save}。
 */
export class JsonStore<T> {
  private loadError: unknown;
  /** 当前内存态（构造时由 {@link load} 填充）。 */
  data: T;

  constructor(
    private readonly filePath: string,
    private readonly makeInitial: () => T,
    private readonly opts: JsonStoreOptions<T> = {},
  ) {
    this.data = this.load();
  }

  /** 原子写盘；strict 模式失败抛错，损坏原件不会被覆盖。 */
  save(): void {
    this.write(this.data);
  }

  /** 先持久化再发布内存态，失败不暴露未保存的变更。 */
  replace(next: T): void {
    this.write(next);
    this.data = next;
  }

  private write(next: T): void {
    if (this.loadError) {
      if (this.opts.strict) throw this.loadError;
      return; // 坏文件保留原件，宽容缓存也不静默覆盖。
    }
    if (this.opts.strict)
      writeFileAtomicSync(
        this.filePath,
        this.opts.pretty ? JSON.stringify(next, null, 2) : JSON.stringify(next),
      );
    else writeJsonFileAtomic(this.filePath, next, this.opts.pretty);
  }

  private load(): T {
    const fallback = (): T => this.makeInitial();
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
        throw error;
      }
      if (raw === null) throw new Error('JSON 存储内容不能为 null');
      return this.opts.normalize ? this.opts.normalize(raw) : (raw as T);
    } catch (error) {
      this.loadError = error;
      if (this.opts.strict)
        throw new Error(`读取 JSON 存储失败，原件已保留：${this.filePath}`, { cause: error });
      return fallback();
    }
  }
}
