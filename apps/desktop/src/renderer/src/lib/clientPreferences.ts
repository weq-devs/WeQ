import { create } from 'zustand';
import {
  legacyPreferenceKeys,
  displayPreferenceKeys,
  isRecord,
  preferenceDefaults,
  validatePreferencePatch,
  type PreferenceKey,
  type PreferencePatch,
  type PreferenceValues,
  type ClientStateSnapshot,
  type StateNamespace,
} from '@weq/service/client-preferences';
import { IS_WEB } from './target';

export const PREFERENCES_CHANGED = 'weq-shared-preferences';
export const ACCOUNT_STATE_CHANGED = 'weq-shared-account-state';
type Binding = { expectedAccountUin: string; expectedAccountConfigId: string };
type Pending = {
  key: PreferenceKey;
  value: PreferenceValues[PreferenceKey];
  sequence: number;
  error?: string;
};
const prefix = 'weq.sync.v1:';
function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
let serverId = typeof window === 'undefined' ? '' : read<string>(`${prefix}server`, '');
function readSharedCache(): ClientStateSnapshot | null {
  const raw: unknown = read(`${prefix}${serverId}:shared`, {});
  try {
    if (
      isRecord(raw) &&
      typeof raw.revision === 'number' &&
      Number.isFinite(raw.revision) &&
      isRecord(raw.values)
    ) {
      validatePreferencePatch(raw.values);
      return {
        settingsRevision:
          typeof raw.settingsRevision === 'number' ? raw.settingsRevision : undefined,
        epoch: typeof raw.epoch === 'string' ? raw.epoch : undefined,
        revision: raw.revision,
        values: raw.values,
        records: {},
      };
    }
    validatePreferencePatch(raw);
    return { revision: -1, values: raw, records: {} };
  } catch {
    return null;
  }
}
const cached = readSharedCache();
let shared: PreferencePatch = cached?.values ?? {};
let revision = cached?.revision ?? -1;
let settingsCommit = cached?.settingsRevision ?? 0;
let epoch = cached?.epoch;
const retiredEpochs = new Set<string>();
let sequence = 0;
const legacyAtStartup = Object.fromEntries(
  Object.values(legacyPreferenceKeys).map((key) => [
    key,
    (() => {
      try {
        return typeof window === 'undefined'
          ? null
          : (globalThis.localStorage?.getItem(key) ?? null);
      } catch {
        return null;
      }
    })(),
  ]),
);
const pending = new Map<PreferenceKey, Pending>();
const retryActions = new Map<string, () => void | Promise<void>>();
export function rememberClientRetry(key: string, run: () => void | Promise<void>) {
  retryActions.set(key, run);
}
export function forgetClientRetry(key: string) {
  if (retryActions.delete(key) && !retryActions.size && !pending.size && !failedRecords.size)
    useClientPreferences.setState({ error: '' });
}
let binding: Binding | null = null;
let account: ClientStateSnapshot = { revision: 0, values: {}, records: {} };
let accountReady = false;
const failedRecords = new Map<
  string,
  { binding: Binding; namespace: StateNamespace; values: Record<string, unknown> }
>();
export function isAccountStateReady() {
  return accountReady;
}
export function currentAccountScope() {
  return binding
    ? JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId])
    : '';
}

export const useClientPreferences = create<{ tick: number; error: string; ready: boolean }>(() => ({
  tick: 0,
  error: '',
  ready: false,
}));
function notify(error?: string) {
  if (error === '') {
    const failure = [...pending.values()].find((operation) => operation.error)?.error;
    if (failure) error = failure;
    else if (failedRecords.size || retryActions.size)
      error = useClientPreferences.getState().error || '仍有内容未保存，请重试';
  }
  useClientPreferences.setState((state) => ({
    tick: state.tick + 1,
    ...(error === undefined ? {} : { error }),
  }));
  window.dispatchEvent(new Event(PREFERENCES_CHANGED));
}
export function preferenceValue<K extends PreferenceKey>(
  key: K,
  fallback?: PreferenceValues[K],
): PreferenceValues[K] {
  const active = pending.get(key);
  if (key === 'contactOrder')
    return {
      ...shared.contactOrder,
      ...(active?.value as Record<string, unknown> | undefined),
    } as PreferenceValues[K];
  return (active?.value ??
    shared[key] ??
    fallback ??
    preferenceDefaults[key]) as PreferenceValues[K];
}
export async function changePreference<K extends PreferenceKey>(
  key: K,
  value: PreferenceValues[K],
): Promise<boolean> {
  const patch = { [key]: value };
  validatePreferencePatch(patch);
  const operation: Pending = { key, value, sequence: ++sequence };
  pending.set(key, operation);
  notify('');
  try {
    if (key === 'accent') await new Promise((resolve) => setTimeout(resolve, 120));
    if (pending.get(key) !== operation) return true;
    const { client } = await import('../trpc/client');
    const snapshot = await client.clientState.patch.mutate(patch);
    if (pending.get(key) !== operation) return true;
    pending.delete(key);
    acceptPreferences(snapshot);
    return true;
  } catch (error) {
    if (pending.get(key) === operation) {
      operation.error = `设置未保存：${error instanceof Error ? error.message : String(error)}`;
      notify(operation.error);
    }
    return false;
  }
}
export function retryPreferences() {
  for (const run of [...retryActions.values()])
    void Promise.resolve(run()).catch((error) => notify(`尚未保存：${String(error)}`));
  for (const { key, value } of [...pending.values()]) void changePreference(key, value);
  for (const [key, failed] of failedRecords) {
    if (JSON.stringify(binding) !== JSON.stringify(failed.binding)) continue;
    void patchAccountRecords(failed.namespace, failed.values)
      .then(() => {
        if (failedRecords.get(key) === failed) failedRecords.delete(key);
        notify(failedRecords.size || pending.size || retryActions.size ? undefined : '');
      })
      .catch((error) => notify(`账号状态未保存：${String(error)}`));
  }
}
export function acceptPreferences(snapshot: ClientStateSnapshot, persist = true) {
  if (snapshot.epoch && retiredEpochs.has(snapshot.epoch)) return;
  if (snapshot.epoch !== epoch) {
    if (epoch) retiredEpochs.add(epoch);
    epoch = snapshot.epoch;
    revision = -1;
    settingsCommit = 0;
  }
  if (snapshot.revision < revision) return;
  revision = snapshot.revision;
  settingsCommit = Math.max(settingsCommit, snapshot.settingsRevision ?? 0);
  shared = snapshot.values;
  try {
    if (persist)
      write(`${prefix}${serverId}:shared`, {
        epoch,
        revision,
        settingsRevision: settingsCommit,
        values: shared,
      });
  } catch {
    /* 共享保存不依赖浏览器缓存。 */
  }
  useClientPreferences.setState({ ready: true });
  notify(pending.size || failedRecords.size || retryActions.size ? undefined : '');
}

/** 较早提交的慢响应不能覆盖已观察到的更新配置；旧服务无修订号时保持兼容。 */
export function acceptSettingsReply(reply: { settingsRevision?: number }): boolean {
  if (reply.settingsRevision === undefined) return true;
  if (reply.settingsRevision < settingsCommit) return false;
  settingsCommit = reply.settingsRevision;
  return true;
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key !== `${prefix}${serverId}:shared`) return;
    const snapshot = readSharedCache();
    if (!snapshot) return;
    if (snapshot.revision < revision) {
      write(`${prefix}${serverId}:shared`, {
        epoch,
        revision,
        settingsRevision: settingsCommit,
        values: shared,
      });
      return;
    }
    acceptPreferences(snapshot, false);
  });
export async function initializePreferences() {
  const { client } = await import('../trpc/client');
  let snapshot = await client.clientState.snapshot.query();
  serverId = snapshot.serverId;
  write(`${prefix}server`, serverId);
  const restoredShared = read<PreferencePatch | null>('weq.sync.restored-shared', null);
  if (restoredShared) {
    validatePreferencePatch(restoredShared);
    const receiptId = localStorage.getItem('weq.backup-client-applied');
    if (!receiptId) throw new Error('共享设置恢复缺少回执，请重新打开备份恢复');
    await client.clientState.restoreLegacyPreferences.mutate({ receiptId, values: restoredShared });
    snapshot = await client.clientState.snapshot.query();
    localStorage.removeItem('weq.sync.restored-shared');
  }
  const marker = `${prefix}${serverId}:shared-only-migrated`;
  let result: ClientStateSnapshot = snapshot;
  if (!read(marker, false)) {
    const legacy: PreferencePatch = {};
    for (const [name, storageKey] of Object.entries(legacyPreferenceKeys)) {
      const key = name as PreferenceKey;
      const raw = legacyAtStartup[storageKey];
      if (raw == null) continue;
      try {
        const value =
          key === 'accent' && /^#[\da-f]{3}$/i.test(raw)
            ? `#${[...raw.slice(1)].map((part) => part + part).join('')}`
            : ['privacyMode', 'capturePrivacy'].includes(key)
              ? raw === '1'
              : key === 'webNotifications'
                ? raw === 'true'
                : ['search', 'calendar'].includes(key)
                  ? JSON.parse(raw)
                  : raw;
        validatePreferencePatch({ [key]: value });
        Object.assign(legacy, { [key]: value });
      } catch {
        /* 无效旧值不覆盖共享配置。 */
      }
    }
    if (!IS_WEB) {
      await client.clientState.seed.mutate(legacy);
      result = await client.clientState.snapshot.query();
    }
    write(marker, true);
  }
  acceptPreferences(result);
}
export function effectiveDisplaySettings<T extends object>(settings: T): T {
  const result = { ...settings };
  for (const key of displayPreferenceKeys)
    if (typeof preferenceDefaults[key] === 'boolean' && (key in shared || pending.has(key)))
      Object.assign(result, { [key]: preferenceValue(key) });
  return result;
}
export function accountBinding() {
  return binding;
}
export function sharedAccountRecords(namespace: StateNamespace) {
  return account.records[namespace] ?? {};
}
export function bindAccountState(next: Binding | null) {
  binding = next;
  const cached = next
    ? read<ClientStateSnapshot | null>(
        `${prefix}${serverId}:${currentAccountScope()}:account`,
        null,
      )
    : null;
  account = cached ?? { revision: 0, values: {}, records: {} };
  accountReady = Boolean(cached);
  window.dispatchEvent(new Event(ACCOUNT_STATE_CHANGED));
}
export function acceptAccountState(snapshot: ClientStateSnapshot, expected: Binding) {
  if (
    JSON.stringify(binding) !== JSON.stringify(expected) ||
    (snapshot.epoch === account.epoch && snapshot.revision < account.revision)
  )
    return;
  account = snapshot;
  accountReady = true;
  try {
    write(`${prefix}${serverId}:${currentAccountScope()}:account`, snapshot);
  } catch {
    /* 账号状态已由电脑保存。 */
  }
  useClientPreferences.setState((state) => ({ tick: state.tick + 1 }));
  window.dispatchEvent(new Event(ACCOUNT_STATE_CHANGED));
}
export async function patchAccountRecords(
  namespace: StateNamespace,
  values: Record<string, unknown>,
  seed = false,
) {
  const expected = binding;
  if (!expected) return;
  const { client } = await import('../trpc/client');
  if (JSON.stringify(binding) !== JSON.stringify(expected))
    throw new Error('账号已切换，请返回原账号重试');
  const snapshot = await client.clientState.accountPatch.mutate({
    ...expected,
    namespace,
    values,
    seed,
  });
  acceptAccountState(snapshot, expected);
}
export function saveAccountRecords(namespace: StateNamespace, values: Record<string, unknown>) {
  const previous = sharedAccountRecords(namespace);
  const patch = Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value),
    ),
  );
  if (!Object.keys(patch).length) return;
  const expected = binding;
  if (!expected) return;
  const key = `${JSON.stringify(expected)}:${namespace}`;
  void patchAccountRecords(namespace, patch).catch((error) => {
    failedRecords.set(key, {
      binding: expected,
      namespace,
      values: { ...failedRecords.get(key)?.values, ...patch },
    });
    notify(`账号状态未保存：${String(error)}`);
  });
}
export async function migrateAccountState(expected: Binding) {
  const { client } = await import('../trpc/client');
  const scope = JSON.stringify([expected.expectedAccountUin, expected.expectedAccountConfigId]);
  const marker = `${prefix}${serverId}:${scope}:migrated`;
  if (read(marker, false)) return;
  const patches: Partial<Record<StateNamespace, Record<string, unknown>>> = {
    pins: {},
    tasks: read(`weq:workspace-read:v1:${encodeURIComponent(scope)}:tasks`, {}),
    assistant: read(`weq:workspace-read:v1:${encodeURIComponent(scope)}:assistant`, {}),
    order: {},
    todos: {},
  };
  const ownerKey = `${prefix}${serverId}:legacy-pins:${expected.expectedAccountUin}`;
  const owner = read<string | null>(ownerKey, null);
  if (!owner || owner === expected.expectedAccountConfigId) {
    if (write(ownerKey, expected.expectedAccountConfigId))
      patches.pins = read(`weq:group-assistant-pins:${expected.expectedAccountUin}`, {});
  }
  for (const kind of ['friends', 'groups']) {
    const value = read(
      `weq.contacts.order.${expected.expectedAccountConfigId}.${expected.expectedAccountUin}.${kind}`,
      null,
    );
    if (value) patches.order![kind] = value;
  }
  const range = localStorage.getItem(
    `weq.contacts.refreshRange.${expected.expectedAccountConfigId}.${expected.expectedAccountUin}`,
  );
  if (range && ['older24h', 'all', 'none'].includes(range)) patches.order!.refreshRange = range;
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith('weq:completed-group-todos:v1:')) continue;
    try {
      const [uin, configId, groupId] = JSON.parse(
        key.slice('weq:completed-group-todos:v1:'.length),
      );
      if (uin === expected.expectedAccountUin && configId === expected.expectedAccountConfigId)
        for (const row of read<Array<{ sequence: string; sourceId?: string }>>(key, []))
          patches.todos![`${groupId}:${row.sourceId || row.sequence}`] = row;
    } catch {
      /* 不迁移其他数据源或无法识别的旧历史。 */
    }
  }
  for (const [namespace, values] of Object.entries(patches)) {
    if (!Object.keys(values).length) continue;
    const snapshot = await client.clientState.accountPatch.mutate({
      ...expected,
      namespace: namespace as StateNamespace,
      values,
      seed: true,
    });
    acceptAccountState(snapshot, expected);
  }
  write(marker, true);
}
