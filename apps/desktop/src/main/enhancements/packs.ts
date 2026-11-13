import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ENHANCEMENT_PACK_IDS, type EnhancementPackId } from '../../shared/enhancement_manifest';

export interface EnhancementComponentState {
  ready: boolean;
  sizeOnDisk: number;
  downloadBytes: number;
  identity: string;
  updateAvailable?: boolean;
  blocker?: string;
}
export interface EnhancementComponent {
  id: string;
  state(): EnhancementComponentState;
  ensure(
    report: (progress: {
      received: number;
      total: number;
      paused?: boolean;
      note?: string;
    }) => void,
  ): Promise<void>;
  check?(): Promise<void>;
  remove(): Promise<void>;
  busy?(): boolean;
  /** 由非本管理器拥有的本地模型仍在使用时保留共享引擎。 */
  retained?(): boolean;
  pause?(): void;
  resume?(): void;
}
export interface EnhancementPackDefinition {
  id: EnhancementPackId;
  name: string;
  description: string;
  components: string[];
  validate(): Promise<void>;
}
export interface PackOperation {
  phase: 'queued' | 'downloading' | 'checking' | 'ready' | 'failed' | 'removing';
  received: number;
  total: number;
  paused?: boolean;
  note?: string;
  error?: string;
}

/** 能力包只协调现有资源；共享组件按物理使用者保留，页面关闭不终止任务。 */
export class EnhancementPacks {
  private readonly operations = new Map<EnhancementPackId, PackOperation>();
  private readonly pending = new Map<EnhancementPackId, Promise<void>>();
  private readonly componentTasks = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  private receipts: Partial<Record<EnhancementPackId, string>> = {};
  private queue = Promise.resolve();
  private writes = Promise.resolve();
  private readonly loaded: Promise<void>;

  constructor(
    readonly definitions: EnhancementPackDefinition[],
    private readonly components: Map<string, EnhancementComponent>,
    private readonly directory: string,
  ) {
    this.loaded = readFile(join(directory, 'ready.json'), 'utf8')
      .then((text) => {
        const saved = JSON.parse(text) as unknown;
        if (saved && typeof saved === 'object')
          for (const id of ENHANCEMENT_PACK_IDS) {
            const identity = (saved as Record<string, unknown>)[id];
            if (typeof identity === 'string') this.receipts[id] = identity;
          }
      })
      .catch(() => {});
  }

  private identity(pack: EnhancementPackDefinition): string {
    return JSON.stringify(
      pack.components.map((id) => [id, this.components.get(id)!.state().identity]),
    );
  }

  async list() {
    await this.loaded;
    return this.definitions.map((pack) => {
      const components = pack.components.map((id) => this.components.get(id)!);
      const states = components.map((component) => component.state());
      const operation = this.operations.get(pack.id);
      const busy = this.pending.has(pack.id) || operation?.phase === 'removing';
      const ready =
        states.every((state) => state.ready && !state.updateAvailable) &&
        this.receipts[pack.id] === this.identity(pack);
      const downloaded = states.every((state) => state.ready) && operation?.phase !== 'failed';
      const installed = components.some(
        (component, index) => !component.id.startsWith('engine:') && states[index]!.sizeOnDisk > 0,
      );
      return {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        ready,
        downloaded,
        busy,
        pausable: components.some((component) => !!component.pause),
        installed,
        updateAvailable: states.some((state) => state.updateAvailable),
        blocker: states.find((state) => state.blocker)?.blocker ?? null,
        downloadBytes: states.reduce((sum, state) => sum + state.downloadBytes, 0),
        sizeOnDisk: installed ? states.reduce((sum, state) => sum + state.sizeOnDisk, 0) : 0,
        sharedBytes: installed
          ? states.reduce(
              (sum, state, index) =>
                sum + (this.shared(pack.id, components[index]!.id) ? state.sizeOnDisk : 0),
              0,
            )
          : 0,
        deleteBytes: installed
          ? states.reduce(
              (sum, state, index) =>
                sum + (this.shared(pack.id, components[index]!.id) ? 0 : state.sizeOnDisk),
              0,
            )
          : 0,
        operation: operation ?? null,
      };
    });
  }

  private shared(excluding: EnhancementPackId, componentId: string): boolean {
    if (this.components.get(componentId)?.retained?.()) return true;
    return this.definitions.some(
      (pack) =>
        pack.id !== excluding &&
        pack.components.includes(componentId) &&
        pack.components.some(
          (id) =>
            id !== componentId &&
            !id.startsWith('engine:') &&
            (this.components.get(id)?.state().sizeOnDisk ?? 0) > 0,
        ),
    );
  }

  plan(ids: readonly EnhancementPackId[]) {
    const components = new Set(
      this.definitions.filter((pack) => ids.includes(pack.id)).flatMap((pack) => pack.components),
    );
    let downloadBytes = 0;
    let sizeOnDisk = 0;
    for (const id of components) {
      const state = this.components.get(id)!.state();
      downloadBytes += state.downloadBytes;
      sizeOnDisk += state.sizeOnDisk;
    }
    return { downloadBytes, sizeOnDisk };
  }

  start(ids: readonly EnhancementPackId[], download = true): void {
    for (const id of new Set(ids)) {
      if (this.pending.has(id)) continue;
      const pack = this.definitions.find((pack) => pack.id === id);
      if (!pack) throw new Error('未知增强包');
      if (pack.components.some((component) => this.deleting.has(component)))
        throw new Error('增强包正在删除，请稍后重试');
      const blocker = pack.components
        .map((component) => this.components.get(component)!.state().blocker)
        .find(Boolean);
      if (blocker) {
        this.operations.set(id, { phase: 'failed', received: 0, total: 0, error: blocker });
        continue;
      }
      this.operations.set(id, {
        phase: 'queued',
        received: 0,
        total: this.plan([id]).downloadBytes,
      });
      const task = this.queue
        .then(() => this.prepare(pack, download))
        .catch((error: unknown) => {
          const previous = this.operations.get(id)!;
          this.operations.set(id, {
            ...previous,
            phase: 'failed',
            paused: false,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => this.pending.delete(id));
      this.pending.set(id, task);
      this.queue = task;
    }
  }

  async wait(): Promise<void> {
    await this.queue;
  }
  isPreparing(id: EnhancementPackId): boolean {
    return this.pending.has(id);
  }
  async waitFor(id: EnhancementPackId): Promise<void> {
    await this.pending.get(id);
  }

  /** 旧完整资源自动验证，不把检查变成启用步骤，也不隐式补下缺失或损坏文件。 */
  async reconcileExisting(): Promise<void> {
    await this.loaded;
    // 应用升级后的兼容引擎由程序协调更新；仅对已有完整能力准备引擎，不隐式补下模型。
    const upgrades = this.definitions
      .filter(
        (pack) =>
          !this.pending.has(pack.id) &&
          this.operations.get(pack.id)?.phase !== 'failed' &&
          pack.components.every((id) => {
            const state = this.components.get(id)!.state();
            return state.ready && !state.blocker;
          }) &&
          pack.components.some((id) => this.components.get(id)!.state().updateAvailable),
      )
      .map((pack) => pack.id);
    this.start(upgrades);
    const ids = this.definitions
      .filter(
        (pack) =>
          !this.pending.has(pack.id) &&
          this.operations.get(pack.id)?.phase !== 'failed' &&
          this.receipts[pack.id] !== this.identity(pack) &&
          pack.components.every((id) => {
            const state = this.components.get(id)!.state();
            return (
              state.ready && !state.updateAvailable && !state.blocker && state.downloadBytes === 0
            );
          }),
      )
      .map((pack) => pack.id);
    this.start(ids, false);
  }

  private async prepare(pack: EnhancementPackDefinition, download: boolean): Promise<void> {
    await this.loaded;
    let completed = 0;
    const total = this.plan([pack.id]).downloadBytes;
    for (const id of pack.components) {
      const component = this.components.get(id)!;
      const missing = component.state().downloadBytes;
      this.operations.set(pack.id, {
        phase: download ? 'downloading' : 'checking',
        received: completed,
        total,
        note: download
          ? id.startsWith('engine:')
            ? '准备推理引擎'
            : '准备资源文件'
          : '正在检查已有资源',
      });
      if (!download) {
        await component.check?.();
        continue;
      }
      let task = this.componentTasks.get(id);
      if (!task) {
        task = component
          .ensure((progress) => {
            this.operations.set(pack.id, {
              phase: 'downloading',
              received: completed + Math.min(missing, progress.received),
              total,
              paused: progress.paused,
              note: progress.note,
            });
          })
          .finally(() => this.componentTasks.delete(id));
        this.componentTasks.set(id, task);
      }
      await task;
      completed += missing;
    }
    this.operations.set(pack.id, {
      phase: 'checking',
      received: total,
      total,
      note: '正在检查实际加载',
    });
    await pack.validate();
    this.receipts[pack.id] = this.identity(pack);
    await this.save();
    this.operations.set(pack.id, { phase: 'ready', received: total, total });
  }

  pause(id: EnhancementPackId) {
    this.control(id, 'pause');
  }
  resume(id: EnhancementPackId) {
    this.control(id, 'resume');
  }
  private control(id: EnhancementPackId, action: 'pause' | 'resume') {
    for (const component of this.definitions.find((pack) => pack.id === id)?.components ?? [])
      this.components.get(component)?.[action]?.();
  }

  async remove(id: EnhancementPackId): Promise<void> {
    const pack = this.definitions.find((pack) => pack.id === id);
    if (!pack) throw new Error('未知增强包');
    const removable = pack.components.filter((component) => !this.shared(id, component));
    if (
      this.pending.has(id) ||
      pack.components.some((component) => this.components.get(component)?.busy?.()) ||
      removable.some((component) => this.deleting.has(component)) ||
      this.definitions.some(
        (other) =>
          this.pending.has(other.id) &&
          other.components.some((component) => removable.includes(component)),
      )
    )
      throw new Error('增强包正在下载或使用，请稍后删除');
    for (const component of removable) this.deleting.add(component);
    this.operations.set(id, { phase: 'removing', received: 0, total: 0 });
    try {
      // 先删除能力专属文件，仍被其他能力或用户模型使用的共享引擎不动。
      for (const component of [...removable].reverse())
        await this.components.get(component)!.remove();
      delete this.receipts[id];
      await this.save();
      this.operations.delete(id);
    } catch (error) {
      this.operations.set(id, {
        phase: 'failed',
        received: 0,
        total: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      for (const component of removable) this.deleting.delete(component);
    }
  }

  private save(): Promise<void> {
    const text = JSON.stringify(this.receipts);
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true });
        const path = join(this.directory, 'ready.json');
        await writeFile(`${path}.tmp`, text);
        await rename(`${path}.tmp`, path);
      });
    this.writes = write;
    return write;
  }
}
