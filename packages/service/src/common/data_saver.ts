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
