import { createReadStream, constants } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, extname } from 'node:path';
import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { ClientStateStore } from '@weq/service/client-state';
import { onSettingsChanged } from '@weq/service/settings-changes';
import {
  displayPreferenceKeys,
  legacyPreferenceKeys,
  MAX_SHARED_DRAFT_IMAGE_BYTES,
  preferenceDefaults,
  validatePreferencePatch,
  type ClientStateChange,
  type PreferencePatch,
} from '@weq/service/client-preferences';
import { getAppContext, requireBootstrap, requirePlatform } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { pickedBrowserFiles } from '../../browser_files';

const stores = new Map<string, ClientStateStore>();
export const clientAccountBinding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
function store(scope: string) {
  const root = requirePlatform().appDataRoot();
  const path =
    scope === 'global'
      ? join(root, 'client-state', 'global.json')
      : join(root, 'config', 'accounts', scope, 'client-state.json');
  let state = stores.get(path);
  if (!state) {
    state = new ClientStateStore(path);
    stores.set(path, state);
  }
  return state;
}
export function boundClientState(input: z.infer<typeof clientAccountBinding>) {
  const context = getAppContext();
  const record = context.services?.accountConfig.getRecord();
  if (
    context.account?.context.uin !== input.expectedAccountUin ||
    record?.configId !== input.expectedAccountConfigId
  )
    throw new Error('账号或数据源已切换，请返回原账号后重试');
  return store(input.expectedAccountConfigId);
}
function draftMediaRoot(configId: string) {
  return join(requirePlatform().appDataRoot(), 'config', 'accounts', configId, 'draft-media');
}
export function trustSharedDraftMedia(value: unknown) {
  const services = getAppContext().services;
  const configId = services?.accountConfig.getRecord()?.configId;
  if (!configId) return;
  const root = draftMediaRoot(configId);
  const stack = [value];
  for (let count = 0; stack.length && count < 10000; count++) {
    const row = stack.pop();
    if (!row || typeof row !== 'object') continue;
    if ('localPath' in row && typeof row.localPath === 'string') {
      const path = relative(root, row.localPath);
      if (
        path &&
        path !== '..' &&
        !path.startsWith('../') &&
        !path.startsWith('..\\') &&
        !isAbsolute(path)
      )
        services?.fileResource.trustPath(row.localPath);
    }
    stack.push(...Object.values(row));
  }
}
const patch = z.custom<PreferencePatch>((value) => {
  try {
    validatePreferencePatch(value);
    return true;
  } catch {
    return false;
  }
});
const namespace = z.enum(['pins', 'tasks', 'assistant', 'todos', 'order']);
export function globalClientState() {
  return { snapshot: preferenceSnapshot, identity: () => store('global').identity() };
}
function settingsRevision() {
  return requireBootstrap().userConfig.sharedPreferenceRevision();
}
function accountSnapshot(input: z.infer<typeof clientAccountBinding>) {
  const snapshot = boundClientState(input).snapshot();
  return {
    ...snapshot,
    records: {
      ...snapshot.records,
      order: requireBootstrap().userConfig.getSharedPreference('order'),
    },
    revision: snapshot.revision + settingsRevision(),
  };
}
function savePreferences(input: PreferencePatch, receiptId?: string, seeded = false) {
  const config = requireBootstrap().userConfig;
  const receipts = config.read().sharedPreferenceRestoreReceipts ?? [];
  if (receiptId && receipts.includes(receiptId)) return preferenceSnapshot();
  const settings = config.getSettings();
  const display = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'contactOrder' && key in settings),
  );
  const appearance = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'contactOrder' && !(key in settings)),
  );
  const raw = config.read().settings ?? {};
  const groups = raw.sharedPreferences ?? {};
  if (Object.keys(input).length || receiptId || seeded)
    config.write({
      settings: {
        ...raw,
        ...display,
        sharedPreferences: {
          ...groups,
          ...(input.contactOrder ? { order: { ...groups.order, ...input.contactOrder } } : {}),
          ...(Object.keys(appearance).length
            ? { client: { ...groups.client, ...appearance } }
            : {}),
        },
      },
      ...(receiptId
        ? { sharedPreferenceRestoreReceipts: [...receipts.slice(-999), receiptId] }
        : {}),
      ...(seeded ? { desktopPreferencesSeeded: true } : {}),
    });
  return preferenceSnapshot();
}
function preferenceSnapshot() {
  const settings = requireBootstrap().userConfig.getSettings();
  const values: PreferencePatch = {};
  for (const key of displayPreferenceKeys)
    if (key in settings) Object.assign(values, { [key]: settings[key as keyof typeof settings] });
  const serverId = store('global').identity();
  return {
    epoch: `unified-preferences-v1:${serverId}`,
    settingsRevision: requireBootstrap().userConfig.sharedPreferenceRevision(),
    records: {},
    values: {
      ...preferenceDefaults,
      ...requireBootstrap().userConfig.getSharedPreference('client'),
      ...values,
      contactOrder: requireBootstrap().userConfig.getSharedPreference('order'),
    },
    revision: settingsRevision(),
    serverId,
  };
}
export const clientStateRouter = router({
  keepDraftMedia: procedure
    .input(clientAccountBinding.extend({ uploadId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      boundClientState(input);
      const services = getAppContext().services!;
      const source = pickedBrowserFiles.complete(services, input.uploadId);
      const info = await stat(source);
      if (!info.isFile() || info.size > MAX_SHARED_DRAFT_IMAGE_BYTES)
        throw new Error('草稿图片需在 32 MiB 以内，原素材仍保留在此设备');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(source)) hash.update(chunk);
      boundClientState(input);
      const root = draftMediaRoot(input.expectedAccountConfigId);
      await mkdir(root, { recursive: true });
      const suffix = extname(source).toLowerCase();
      const digest = hash.digest('hex');
      const path = join(root, `${digest}${/^\.[a-z0-9]{1,10}$/.test(suffix) ? suffix : ''}`);
      try {
        await copyFile(source, path, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = createHash('sha256');
        for await (const chunk of createReadStream(path)) existing.update(chunk);
        if (existing.digest('hex') !== digest)
          throw new Error('草稿素材位置已有不同内容，已保留原件');
      }
      boundClientState(input);
      services.fileResource.trustPath(path);
      return { path };
    }),
  snapshot: procedure.query(() => preferenceSnapshot()),
  patch: procedure.input(patch).mutation(({ input }) => savePreferences(input)),
  restoreLegacyPreferences: procedure
    .input(z.object({ receiptId: z.string().uuid(), values: patch }))
    .mutation(({ input }) => {
      if (Object.keys(input.values).some((key) => !Object.hasOwn(legacyPreferenceKeys, key)))
        throw new Error('旧界面备份包含非共享界面字段');
      savePreferences(input.values, input.receiptId);
      return preferenceSnapshot();
    }),
  seed: procedure.input(patch).mutation(({ input, ctx }) => {
    if (ctx.host) throw new Error('共享初始值由桌面端提供');
    const config = requireBootstrap().userConfig;
    if (config.read().desktopPreferencesSeeded) return preferenceSnapshot();
    const existing = config.getSharedPreference('client');
    const fresh = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          !Object.hasOwn(existing, key) && !Object.hasOwn(config.read().settings ?? {}, key),
      ),
    );
    return savePreferences(fresh, undefined, true);
  }),
  changed: procedure.subscription(() =>
    observable<ClientStateChange>((emit) => {
      const stopSettings = onSettingsChanged(() =>
        emit.next({ revision: Date.now(), section: 'preferences' }),
      );
      return () => {
        stopSettings();
      };
    }),
  ),
  accountSnapshot: procedure
    .input(clientAccountBinding)
    .query(({ input }) => accountSnapshot(input)),
  accountPatch: procedure
    .input(
      clientAccountBinding.extend({
        namespace,
        values: z.record(z.unknown()),
        seed: z.boolean().default(false),
      }),
    )
    .mutation(({ input }) => {
      boundClientState(input);
      if (input.namespace === 'order') {
        // 旧设备的初始化值不能在切号时重新接管全局排序。
        if (!input.seed) requireBootstrap().userConfig.patchSharedPreference('order', input.values);
        return accountSnapshot(input);
      }
      boundClientState(input).records(input.namespace, input.values, input.seed);
      return accountSnapshot(input);
    }),
  accountChanged: procedure.input(clientAccountBinding).subscription(({ input }) => {
    const state = boundClientState(input);
    return observable<ClientStateChange>((emit) => {
      const publish = (event: ClientStateChange) => {
        try {
          if (boundClientState(input) === state) emit.next(event);
        } catch {
          emit.complete();
        }
      };
      const stop = state.subscribe(publish);
      const stopSettings = onSettingsChanged(() =>
        publish({ revision: Date.now(), section: 'order' }),
      );
      return () => {
        stop();
        stopSettings();
      };
    });
  }),
  draft: procedure
    .input(clientAccountBinding.extend({ key: z.string().min(1).max(1024) }))
    .query(({ input }) => {
      const draft = boundClientState(input).draft(input.key);
      trustSharedDraftMedia(draft.value);
      return draft;
    }),
  saveDraft: procedure
    .input(
      clientAccountBinding.extend({
        key: z.string().min(1).max(1024),
        value: z.unknown(),
        expectedVersion: z.string().nullable(),
      }),
    )
    .mutation(({ input }) => {
      const state = boundClientState(input);
      if (input.key.startsWith('assistant:') && input.key !== 'assistant:new') {
        const id = input.key.slice('assistant:'.length);
        if (
          !getAppContext()
            .services?.assistant.listSessions()
            .some((session) => session.id === id)
        )
          throw new Error('这段助手会话已删除，草稿不再保存。');
      }
      return state.saveDraft(input.key, input.value, input.expectedVersion);
    }),
});
