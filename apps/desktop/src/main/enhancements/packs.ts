import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '@weq/service';
import { join } from 'node:path';
import { ENHANCEMENT_PACK_IDS, type EnhancementPackId } from '../../shared/enhancement_manifest';
import type {
  EnhancementRelease,
  EnhancementReleaseComponent,
} from '../../shared/enhancement_release';
import { TransferGate } from '@weq/service/data-saver';
import { networkScope } from '@weq/service/network-scope';

export interface EnhancementComponentState {
  ready: boolean;
  installed?: boolean;
  sizeOnDisk: number;
  downloadBytes: number;
  identity: string;
  updateAvailable?: boolean;
  blocker?: string;
  requiresWeqUpdate?: boolean;
}
export interface EnhancementComponent {
  id: string;
  name?: string;
  state(): EnhancementComponentState;
  inspect?(): Promise<void>;
  ensure(
    report: (progress: {
      received: number;
      total: number;
      paused?: boolean;
      pauseReasons?: string[];
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
  select?(component: EnhancementReleaseComponent): void;
  activate?(): (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
  cleanup?(): Promise<void>;
  installation?(): Record<string, unknown>;
}
export interface EnhancementPackDefinition {
  id: EnhancementPackId;
  name: string;
  description: string;
  components: string[];
  validate(): Promise<void>;
  validateShared?(): Promise<void>;
  lockActivation?(): Promise<() => void>;
}
export interface PackOperation {
  phase: 'queued' | 'downloading' | 'checking' | 'installing' | 'ready' | 'failed' | 'removing';
  received: number;
  total: number;
  paused?: boolean;
  pauseReasons?: string[];
  note?: string;
  error?: string;
}

/** 能力包只协调现有资源；共享组件按物理使用者保留，页面关闭不终止任务。 */
export class EnhancementPacks {
  private resolveRelease?: (id: EnhancementPackId) => Promise<void>;
  setReleaseResolver(resolve: (id: EnhancementPackId) => Promise<void>) {
    this.resolveRelease = resolve;
  }
  private preparationObserver?: (id: EnhancementPackId, name: string) => void;
  private readonly settled = new Set<(id: EnhancementPackId) => void>();
  onSettled(listener: (id: EnhancementPackId) => void) {
    this.settled.add(listener);
    return () => this.settled.delete(listener);
  }
  observePreparations(observer: (id: EnhancementPackId, name: string) => void) {
    this.preparationObserver = observer;
  }
  private readonly operations = new Map<EnhancementPackId, PackOperation>();
  private readonly pending = new Map<EnhancementPackId, Promise<void>>();
  private readonly componentTasks = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  private readonly removed = new Set<EnhancementPackId>();
  private readonly installed = new Set<EnhancementPackId>();
  private receipts: Partial<Record<EnhancementPackId, string>> = {};
  private queue = Promise.resolve();
  private writes = Promise.resolve();
  private readonly loaded: Promise<void>;
  private readonly releases = new Map<
    EnhancementPackId,
    { release: EnhancementRelease; blocker: string | null; requiresWeqUpdate: boolean }
  >();
  private readonly installedVersions = new Map<EnhancementPackId, string>();
  private readonly gates = new Map<EnhancementPackId, { gate: TransferGate; continued: boolean }>();

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
            if (identity && typeof identity === 'object') {
              if ((identity as { removed?: unknown }).removed === true) this.removed.add(id);
              const receipt = identity as {
                identity?: string;
                contentVersion?: string;
                installed?: boolean;
              };
              if (receipt.installed) this.installed.add(id);
              if (typeof receipt.identity === 'string') this.receipts[id] = receipt.identity;
              if (typeof receipt.contentVersion === 'string')
                this.installedVersions.set(id, receipt.contentVersion);
            }
          }
      })
      .catch(() => {});
  }

  selectRelease(
    release: EnhancementRelease,
    blocker: string | null,
    requiresWeqUpdate = !!blocker,
  ): void {
    this.releases.set(release.id, { release, blocker, requiresWeqUpdate });
    if (this.pending.has(release.id)) return;
    if (blocker) return;
    this.selectComponents(release);
  }
  private selectComponents(release: EnhancementRelease, queued = false) {
    const definition = this.definitions.find((pack) => pack.id === release.id)!;
    for (const component of release.components) {
      const id =
        component.type === 'model'
          ? `model:${component.id}`
          : component.type === 'engine'
            ? `engine:${component.artifact.kind}`
            : 'dress:index';
      if (!definition.components.includes(id)) throw new Error('增强包组件不匹配');
      if (
        queued ||
        !this.definitions.some((pack) => this.pending.has(pack.id) && pack.components.includes(id))
      )
        this.components.get(id)?.select?.(component);
    }
  }

  private identity(pack: EnhancementPackDefinition): string {
    return JSON.stringify(
      pack.components.map((id) => [id, this.components.get(id)!.state().identity]),
    );
  }

  async list() {
    await this.loaded;
    await Promise.all([...this.components.values()].map((component) => component.inspect?.()));
    return this.definitions.map((pack) => {
      const components = pack.components.map((id) => this.components.get(id)!);
      const states = components.map((component) => component.state());
      const operation = this.operations.get(pack.id);
      const busy = this.pending.has(pack.id) || operation?.phase === 'removing';
      const selected = this.releases.get(pack.id);
      const version = this.installedVersions.get(pack.id);
      const ready =
        !this.removed.has(pack.id) &&
        states.every((state) => state.ready) &&
        this.receipts[pack.id] === this.identity(pack);
      const downloaded = !this.removed.has(pack.id) && states.every((state) => state.ready);
      const installed =
        !this.removed.has(pack.id) &&
        (this.installed.has(pack.id) ||
          !!this.receipts[pack.id] ||
          components.some(
            (component, index) =>
              !component.id.startsWith('engine:') &&
              (states[index]!.installed || states[index]!.ready),
          ));
      return {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        ready,
        downloaded,
        busy,
        pausable: components.some((component) => !!component.pause),
        installed,
        needsRepair: installed && !downloaded,
        missingComponents: components.flatMap((component, index) =>
          states[index]!.ready ? [] : [component.name ?? component.id],
        ),
        installedVersion: installed ? (version ?? 'legacy') : null,
        latestVersion: selected?.release.contentVersion ?? null,
        minWeqVersion: selected?.release.minWeqVersion ?? null,
        requiresWeqUpdate:
          !!selected?.requiresWeqUpdate || states.some((state) => state.requiresWeqUpdate),
        updateAvailable:
          installed &&
          (states.some((state) => state.updateAvailable || !state.ready) ||
            (!!version && !!selected && version !== selected.release.contentVersion)),
        blocker: selected?.blocker ?? states.find((state) => state.blocker)?.blocker ?? null,
        downloadBytes: states.reduce((sum, state) => sum + state.downloadBytes, 0),
        sizeOnDisk: states.reduce((sum, state) => sum + state.sizeOnDisk, 0),
        sharedBytes: states.reduce(
          (sum, state, index) =>
            sum + (this.shared(pack.id, components[index]!.id) ? state.sizeOnDisk : 0),
          0,
        ),
        deleteBytes: states.reduce(
          (sum, state, index) =>
            sum + (this.shared(pack.id, components[index]!.id) ? 0 : state.sizeOnDisk),
          0,
        ),
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
      const blocker =
        download && this.resolveRelease
          ? null
          : (pack.components
              .map((component) => this.components.get(component)!.state().blocker)
              .find(Boolean) ?? (download ? this.releases.get(id)?.blocker : null));
      if (blocker) {
        this.operations.set(id, { phase: 'failed', received: 0, total: 0, error: blocker });
        continue;
      }
      this.operations.set(id, {
        phase: 'queued',
        received: 0,
        total: this.plan([id]).downloadBytes,
      });
      this.gates.set(id, { gate: new TransferGate(), continued: false });
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
        .finally(() => {
          this.pending.delete(id);
          this.gates.delete(id);
          const latest = this.releases.get(id);
          if (latest && !latest.blocker) this.selectComponents(latest.release);
          setTimeout(() => {
            for (const listener of this.settled) listener(id);
          }, 0).unref();
        });
      this.pending.set(id, task);
      this.queue = task;
      this.preparationObserver?.(id, pack.name);
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
    let changed = false;
    for (const pack of await this.list()) {
      if (pack.installed && !this.installed.has(pack.id)) {
        this.installed.add(pack.id);
        changed = true;
      }
    }
    if (changed) await this.save();
    const ids = this.definitions
      .filter(
        (pack) =>
          !this.pending.has(pack.id) &&
          this.operations.get(pack.id)?.phase !== 'failed' &&
          !this.removed.has(pack.id) &&
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
    if (download && this.resolveRelease) {
      this.operations.set(pack.id, {
        phase: 'checking',
        received: 0,
        total: 0,
        note: '读取在线增强包清单',
      });
      await this.resolveRelease(pack.id);
    }
    const selected = download ? this.releases.get(pack.id) : undefined;
    const release = selected;
    if (download && release) {
      if (release.blocker) throw new Error(release.blocker);
      this.selectComponents(release.release, true);
    }
    const blocker = pack.components
      .map((id) => this.components.get(id)!.state().blocker)
      .find(Boolean);
    if (blocker) throw new Error(blocker);
    await Promise.all(pack.components.map((id) => this.components.get(id)!.inspect?.()));
    let completed = 0;
    const budgets = pack.components.map((id) => this.components.get(id)!.state().downloadBytes);
    const total = budgets.reduce((sum, bytes) => sum + bytes, 0);
    for (const [index, id] of pack.components.entries()) {
      const component = this.components.get(id)!;
      const control = this.gates.get(pack.id)!;
      await control.gate.wait();
      const missing = budgets[index]!;
      const base = completed;
      let received = 0;
      let reporting = true;
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
      try {
        let task = this.componentTasks.get(id);
        if (!task) {
          task = networkScope
            .run(
              {
                ...networkScope.getStore(),
                restricted: networkScope.getStore()?.restricted ?? false,
                intent: 'batch',
                override: control.continued,
              },
              async () => {
                while (control.gate.paused) await control.gate.wait();
                return component.ensure((progress) => {
                  if (!reporting) return;
                  if (Number.isFinite(progress.received))
                    received = Math.max(received, Math.min(missing, progress.received));
                  this.operations.set(pack.id, {
                    phase: 'downloading',
                    received: base + received,
                    total,
                    paused: control.gate.paused || progress.paused,
                    pauseReasons: control.gate.paused
                      ? control.gate.pauseReasons
                      : progress.pauseReasons,
                    note: progress.note,
                  });
                });
              },
            )
            .finally(() => this.componentTasks.delete(id));
          this.componentTasks.set(id, task);
        }
        await task;
      } finally {
        // 上一组件的迟到事件不能覆盖新阶段、校验或失败状态。
        reporting = false;
      }
      completed += missing;
    }
    this.operations.set(pack.id, {
      phase: 'checking',
      received: total,
      total,
      note: '正在检查实际加载',
      paused: this.gates.get(pack.id)!.gate.paused,
      pauseReasons: this.gates.get(pack.id)!.gate.pauseReasons,
    });
    await this.gates.get(pack.id)!.gate.wait();
    await pack.validate();
    await pack.validateShared?.();
    await this.gates.get(pack.id)!.gate.wait();
    let unlock: (() => void) | undefined;
    for (;;) {
      await this.gates.get(pack.id)!.gate.wait();
      unlock = await pack.lockActivation?.();
      if (!this.gates.get(pack.id)!.gate.paused) break;
      unlock?.();
    }
    while (pack.components.some((id) => this.components.get(id)?.busy?.()))
      await new Promise((resolve) => setTimeout(resolve, 100));
    const undo: Array<() => void | Promise<void>> = [];
    const previousReceipt = this.receipts[pack.id];
    const previousReceipts = { ...this.receipts };
    const previousVersion = this.installedVersions.get(pack.id);
    const previouslyRemoved = this.removed.has(pack.id);
    this.operations.set(pack.id, {
      phase: 'installing',
      received: total,
      total,
      note: '正在切换资源',
    });
    try {
      for (const id of pack.components) {
        const revert = await this.components.get(id)?.activate?.();
        if (revert) undo.push(revert);
      }
      this.receipts[pack.id] = this.identity(pack);
      this.removed.delete(pack.id);
      if (selected) this.installedVersions.set(pack.id, selected.release.contentVersion);
      if (pack.validateShared)
        for (const other of this.definitions) {
          if (
            other.id !== pack.id &&
            this.receipts[other.id] &&
            other.components.some((id) => id.startsWith('engine:') && pack.components.includes(id))
          )
            this.receipts[other.id] = this.identity(other);
        }
      await this.save();
    } catch (error) {
      for (const revert of undo.reverse()) await revert();
      this.receipts = previousReceipts;
      if (previouslyRemoved) this.removed.add(pack.id);
      else this.removed.delete(pack.id);
      if (previousReceipt) this.receipts[pack.id] = previousReceipt;
      else delete this.receipts[pack.id];
      if (previousVersion) this.installedVersions.set(pack.id, previousVersion);
      else this.installedVersions.delete(pack.id);
      throw error;
    } finally {
      unlock?.();
    }
    for (const id of pack.components)
      await this.components
        .get(id)
        ?.cleanup?.()
        .catch(() => {});
    this.operations.set(pack.id, { phase: 'ready', received: total, total });
  }

  pause(id: EnhancementPackId) {
    if (this.operations.get(id)?.phase === 'installing') return;
    this.gates.get(id)?.gate.pause();
    const operation = this.operations.get(id);
    if (operation && this.pending.has(id))
      this.operations.set(id, { ...operation, paused: true, pauseReasons: ['user'] });
    this.control(id, 'pause');
  }
  resume(id: EnhancementPackId) {
    const operation = this.operations.get(id);
    if (operation && this.pending.has(id))
      this.operations.set(id, { ...operation, paused: false, pauseReasons: [] });
    const control = this.gates.get(id);
    if (control) {
      control.continued = true;
      control.gate.continue();
    }
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
      this.removed.add(id);
      await this.save();
      // 先删除能力专属文件，仍被其他能力或用户模型使用的共享引擎不动。
      for (const component of [...removable].reverse())
        await this.components.get(component)!.remove();
      delete this.receipts[id];
      this.installed.delete(id);
      this.installedVersions.delete(id);
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
    const text = JSON.stringify(
      Object.fromEntries(
        [...new Set([...Object.keys(this.receipts), ...this.installed, ...this.removed])].map(
          (id) => [
            id,
            {
              identity: this.receipts[id as EnhancementPackId],
              removed: this.removed.has(id as EnhancementPackId),
              installed: !this.removed.has(id as EnhancementPackId),
              contentVersion: this.installedVersions.get(id as EnhancementPackId),
              components: this.definitions
                .find((pack) => pack.id === id)
                ?.components.flatMap((componentId) => {
                  const value = this.components.get(componentId)?.installation?.();
                  return value ? [value] : [];
                }),
            },
          ],
        ),
      ),
    );
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        const path = join(this.directory, 'ready.json');
        await writeFileAtomic(path, text);
      });
    this.writes = write;
    return write;
  }
}
