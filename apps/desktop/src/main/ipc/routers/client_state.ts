import { statSync, createReadStream, constants } from 'node:fs';
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
  return store('global');
}
function savePreferences(input: PreferencePatch) {
  const settings = requireBootstrap().userConfig.getSettings();
  const display = Object.fromEntries(Object.entries(input).filter(([key]) => key in settings));
  const appearance = Object.fromEntries(
    Object.entries(input).filter(([key]) => !(key in settings)),
  );
  if (Object.keys(appearance).length) globalClientState().patch(appearance);
  if (Object.keys(display).length) requireBootstrap().userConfig.setSettings(display);
  return preferenceSnapshot();
}
function preferenceSnapshot() {
  const settings = requireBootstrap().userConfig.getSettings();
  const values: PreferencePatch = {};
  for (const key of displayPreferenceKeys)
    if (key in settings) Object.assign(values, { [key]: settings[key as keyof typeof settings] });
  const snapshot = globalClientState().snapshot();
  return {
    ...snapshot,
    values: { ...preferenceDefaults, ...snapshot.values, ...values },
    revision: Math.max(
      snapshot.revision,
      statSync(globalClientState().path, { throwIfNoEntry: false })?.mtimeMs ?? 0,
      statSync(join(requirePlatform().appDataRoot(), 'config.json'), { throwIfNoEntry: false })
        ?.mtimeMs ?? 0,
    ),
    serverId: globalClientState().identity(),
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
      globalClientState().restorePreferences(input.values, input.receiptId);
      return preferenceSnapshot();
    }),
  seed: procedure.input(patch).mutation(({ input, ctx }) => {
    if (ctx.host) throw new Error('共享初始值由桌面端提供');
    return globalClientState().seed(input);
  }),
  changed: procedure.subscription(() =>
    observable<ClientStateChange>((emit) => {
      const stop = globalClientState().subscribe((event) => emit.next(event));
      const stopSettings = onSettingsChanged(() =>
        emit.next({ revision: Date.now(), section: 'preferences' }),
      );
      return () => {
        stop();
        stopSettings();
      };
    }),
  ),
  accountSnapshot: procedure
    .input(clientAccountBinding)
    .query(({ input }) => boundClientState(input).snapshot()),
  accountPatch: procedure
    .input(
      clientAccountBinding.extend({
        namespace,
        values: z.record(z.unknown()),
        seed: z.boolean().default(false),
      }),
    )
    .mutation(({ input }) =>
      boundClientState(input).records(input.namespace, input.values, input.seed),
    ),
  accountChanged: procedure.input(clientAccountBinding).subscription(({ input }) => {
    const state = boundClientState(input);
    return observable<ClientStateChange>((emit) =>
      state.subscribe((event) => {
        try {
          if (boundClientState(input) === state) emit.next(event);
        } catch {
          emit.complete();
        }
      }),
    );
  }),
  draft: procedure
    .input(clientAccountBinding.extend({ key: z.string().min(1).max(1024) }))
    .query(({ input }) => {
      const draft = boundClientState(input).draft(input.key);
      trustSharedDraftMedia(draft.value);
      return draft;
    }),
  draftCopies: procedure
    .input(clientAccountBinding)
    .query(({ input }) => boundClientState(input).copies()),
  saveDraft: procedure
    .input(
      clientAccountBinding.extend({
        key: z.string().min(1).max(1024),
        value: z.unknown(),
        expectedVersion: z.string().nullable(),
      }),
    )
    .mutation(({ input }) =>
      boundClientState(input).saveDraft(input.key, input.value, input.expectedVersion),
    ),
});
