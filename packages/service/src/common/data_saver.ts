export type DataSaverMode = 'auto' | 'always' | 'never';
export const dataSaverBehaviorDefaults = {
  dataSaverImageLoading: 'thumbnail' as 'none' | 'thumbnail' | 'original',
  dataSaverAvatars: true,
  dataSaverEmoji: false,
  dataSaverDress: false,
  dataSaverVideoCovers: true,
  dataSaverPrefetch: false,
  dataSaverLinkPreviews: false,
  dataSaverPauseBatch: true,
  dataSaverPauseLarge: true,
  dataSaverLargeMiB: 10,
  dataSaverAutoResume: true,
};
export type DataSaverBehavior = typeof dataSaverBehaviorDefaults;
export type NetworkResource =
  | 'avatar'
  | 'video-cover'
  | 'emoji'
  | 'dress'
  | 'link-preview'
  | 'image';
export interface NetworkCost {
  state: 'restricted' | 'unrestricted' | 'unknown';
  constrained: boolean;
  metered: boolean;
  source: string;
}
export const UNKNOWN_NETWORK: NetworkCost = {
  state: 'unknown',
  constrained: false,
  metered: false,
  source: 'unavailable',
};
export const LARGE_TRANSFER_BYTES = 10 * 1024 * 1024;
export function networkCost(constrained: boolean, metered: boolean, source: string): NetworkCost {
  return {
    state: constrained || metered ? 'restricted' : 'unrestricted',
    constrained,
    metered,
    source,
  };
}
export function dataSaverEnabled(mode: DataSaverMode, ...networks: NetworkCost[]): boolean {
  return mode === 'always' || (mode !== 'never' && networks.some((n) => n.state === 'restricted'));
}
export type DataSaverChangeReason =
  | 'initial'
  | 'system'
  | 'settings'
  | 'temporary'
  | 'restore'
  | 'expiry'
  | 'tasks';
export type DataSaverTemporaryRequest =
  | { enabled: boolean; duration: 'exit' }
  | { enabled: boolean; duration: 'minutes'; minutes: number }
  | { enabled: false; duration: 'tasks' };
export interface DataSaverTemporary {
  enabled: boolean;
  duration: 'exit' | 'minutes' | 'tasks';
  expiresAt: number | null;
}
export interface DataSaverStatus {
  sessionId: string;
  mode: DataSaverMode;
  effectiveMode: DataSaverMode;
  host: NetworkCost;
  local: NetworkCost;
  enabled: boolean;
  temporary: DataSaverTemporary | null;
  pendingTasks: number | null;
  revision: number;
  reason: DataSaverChangeReason;
}

/** 本次宿主运行共用的覆盖；系统 unknown 不撤销已确认的网络限制。 */
export class DataSaverSession {
  private sessionId = globalThis.crypto.randomUUID();
  private mode: DataSaverMode = 'auto';
  private host = UNKNOWN_NETWORK;
  private clients = new Map<string, NetworkCost>();
  private temporary: DataSaverTemporary | null = null;
  private pendingTasks: number | null = null;
  private revision = 0;
  private reason: DataSaverChangeReason = 'initial';
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  status(clientId?: string): DataSaverStatus {
    const effectiveMode = this.temporary
      ? this.temporary.enabled
        ? 'always'
        : 'never'
      : this.mode;
    const local = this.clients.get(clientId ?? '') ?? this.host;
    return {
      sessionId: this.sessionId,
      mode: this.mode,
      effectiveMode,
      host: this.host,
      local,
      enabled: dataSaverEnabled(effectiveMode, this.host, local),
      temporary: this.temporary ? { ...this.temporary } : null,
      pendingTasks: this.pendingTasks,
      revision: this.revision,
      reason: this.reason,
    };
  }
  update(mode: DataSaverMode, cost: NetworkCost) {
    const modeChanged = mode !== this.mode;
    const host = cost.state === 'unknown' && this.host.state !== 'unknown' ? this.host : cost;
    const networkChanged = JSON.stringify(host) !== JSON.stringify(this.host);
    this.mode = mode;
    this.host = host;
    if (modeChanged) this.cancelTimer();
    if (modeChanged) this.temporary = null;
    if (modeChanged || networkChanged) this.emit(modeChanged ? 'settings' : 'system');
  }
  updateClient(clientId: string, cost: NetworkCost) {
    const previous = this.clients.get(clientId);
    if (cost.state === 'unknown' && previous?.state !== 'unknown' && previous) return;
    if (JSON.stringify(previous) === JSON.stringify(cost)) return;
    this.clients.set(clientId, cost);
    if (this.clients.size > 256) this.clients.delete(this.clients.keys().next().value!);
    this.emit('system');
  }
  setTemporary(input: DataSaverTemporaryRequest) {
    if (
      input.duration === 'minutes' &&
      (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440)
    )
      throw new Error('分钟数须为 1–1440 的整数');
    if (
      input.duration === 'tasks' &&
      (input.enabled || this.pendingTasks === null || this.pendingTasks === 0)
    )
      throw new Error('暂无已确认的未完成任务，请选择其他期限');
    this.cancelTimer();
    const expiresAt = input.duration === 'minutes' ? Date.now() + input.minutes * 60000 : null;
    this.temporary = { enabled: input.enabled, duration: input.duration, expiresAt };
    if (expiresAt !== null) {
      this.timer = setTimeout(
        () => this.clearTemporary('expiry'),
        Math.max(0, expiresAt - Date.now()),
      );
      this.timer.unref?.();
    }
    this.emit('temporary');
  }
  clearTemporary(reason: DataSaverChangeReason = 'restore') {
    if (!this.temporary) return;
    this.cancelTimer();
    this.temporary = null;
    this.emit(reason);
  }
  setPendingTasks(count: number | null) {
    if (count === this.pendingTasks) return;
    this.pendingTasks = count;
    this.emit();
  }
  finishTasks() {
    if (this.temporary?.duration === 'tasks' && this.pendingTasks === 0)
      this.clearTemporary('tasks');
  }
  dispose() {
    this.cancelTimer();
    this.listeners.clear();
  }
  private cancelTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private emit(reason?: DataSaverChangeReason) {
    this.revision++;
    if (reason) this.reason = reason;
    for (const listener of this.listeners) listener();
  }
}
export type NetworkIntent = 'prefetch' | 'thumbnail' | 'interactive' | 'batch';
export function allowNetwork(
  restricted: boolean,
  intent: NetworkIntent,
  behavior: DataSaverBehavior = dataSaverBehaviorDefaults,
  resource?: NetworkResource,
): boolean {
  if (!restricted || intent === 'interactive') return true;
  if (intent === 'batch') return !behavior.dataSaverPauseBatch;
  if (resource === 'avatar') return behavior.dataSaverAvatars;
  if (resource === 'video-cover') return behavior.dataSaverVideoCovers;
  if (resource === 'emoji') return behavior.dataSaverEmoji;
  if (resource === 'dress') return behavior.dataSaverDress;
  if (resource === 'link-preview') return behavior.dataSaverLinkPreviews;
  if (resource === 'image') return behavior.dataSaverImageLoading !== 'none';
  return intent === 'thumbnail' || behavior.dataSaverPrefetch;
}
export function shouldPauseTransfer(
  restricted: boolean,
  batch: boolean,
  total = 0,
  received = 0,
  behavior: DataSaverBehavior = dataSaverBehaviorDefaults,
): boolean {
  const limit = behavior.dataSaverLargeMiB * 1024 * 1024;
  return (
    restricted &&
    ((batch && behavior.dataSaverPauseBatch) ||
      (behavior.dataSaverPauseLarge && (total >= limit || received >= limit)))
  );
}

/** 策略暂停独立于用户暂停；只有对应限制解除才可自动继续。 */
export class TransferGate {
  private reasons = new Set<string>();
  private waiting = new Set<() => void>();
  private override = false;
  private manual = false;
  get paused() {
    return this.manual || (!this.override && this.reasons.size > 0);
  }
  get pauseReasons() {
    return this.manual ? ['user'] : this.override ? [] : [...this.reasons];
  }
  restrict(source: string, value: boolean) {
    if (value) this.reasons.add(source);
    else this.reasons.delete(source);
    this.notify();
  }
  pause() {
    this.manual = true;
  }
  continue() {
    this.manual = false;
    this.override = true;
    this.notify();
  }
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.paused) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const cleanup = () => {
        this.waiting.delete(done);
        signal?.removeEventListener('abort', abort);
      };
      this.waiting.add(done);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  private notify() {
    if (!this.paused) for (const done of [...this.waiting]) done();
  }
}
