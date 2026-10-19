import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ExportSavePolicy } from '@weq/service';
import { client, trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { useToast } from '../components/Toast';
import { useViewState } from '../state/view';
import { IS_WEB } from '../lib/target';

interface SaveDraft {
  identity: string;
  override: ExportSavePolicy | null;
  directories: Partial<Record<'preset' | 'before', string>>;
  filePaths: Partial<Record<'preset' | 'before', string>>;
}
function emptyDraft(identity: string): SaveDraft {
  return { identity, override: null, directories: {}, filePaths: {} };
}

/** 导出与资源下载共用保存准备；单次参数不自动覆盖全局默认。 */
export function useExportSavePolicy() {
  const settings = trpc.bootstrap.getSettings.useQuery();
  const utils = trpc.useUtils();
  const dialog = useAppDialog();
  const pushToast = useToast((state) => state.push);
  const accountUin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: Boolean(accountUin),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const binding =
    accountUin && config.data?.uin === accountUin && config.data.configId
      ? { expectedAccountUin: accountUin, expectedAccountConfigId: config.data.configId }
      : null;
  const identity = `${accountUin ?? ''}:${binding?.expectedAccountConfigId ?? ''}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const mounted = useRef(true);
  const pickInFlight = useRef(false);
  const prepareInFlight = useRef(false);
  const [picking, setPicking] = useState(false);
  const [serverLocation, setServerLocation] = useState<{ name: string } | null>(null);
  const resolveServerLocation = useRef<((directory: string | null) => void) | null>(null);
  const [draft, setDraft] = useState<SaveDraft>(() => emptyDraft(identity));
  const scopedDraft = draft.identity === identity ? draft : emptyDraft(identity);
  const { override } = scopedDraft;
  // 每种模式保留本次目录，模式切换不把 Web 子目录当成预设，也不丢临时覆盖。
  const setOverride: Dispatch<SetStateAction<ExportSavePolicy | null>> = (action) => {
    setDraft((previous) => {
      const scoped = previous.identity === identity ? previous : emptyDraft(identity);
      const next = typeof action === 'function' ? action(scoped.override) : action;
      if (!next) return emptyDraft(identity);
      const directories = { ...scoped.directories };
      const filePaths = { ...scoped.filePaths };
      if (next.mode !== 'after') {
        if (next.filePath) {
          filePaths[next.mode] = next.filePath;
          delete directories[next.mode];
        } else if (next.directory) {
          directories[next.mode] = next.directory;
          delete filePaths[next.mode];
        } else if (scoped.override?.mode === next.mode) {
          delete directories[next.mode];
          delete filePaths[next.mode];
        }
      }
      const directory = next.mode === 'after' ? undefined : directories[next.mode];
      const filePath = next.mode === 'after' ? undefined : filePaths[next.mode];
      return {
        identity,
        override: {
          mode: next.mode,
          ...(directory ? { directory } : {}),
          ...(filePath ? { filePath } : {}),
        },
        directories,
        filePaths,
      };
    });
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resolveServerLocation.current?.(null);
      resolveServerLocation.current = null;
    };
  }, []);
  useEffect(() => {
    resolveServerLocation.current?.(null);
    resolveServerLocation.current = null;
    setServerLocation(null);
  }, [identity]);
  const mode = override?.mode ?? settings.data?.exportSaveMode ?? 'before';
  const directory =
    mode === 'preset'
      ? (override?.directory ?? scopedDraft.directories.preset ?? settings.data?.defaultExportDir)
      : mode === 'before'
        ? (override?.directory ?? scopedDraft.directories.before)
        : undefined;
  const filePath =
    mode === 'after' ? undefined : (override?.filePath ?? scopedDraft.filePaths[mode]);
  const policy: ExportSavePolicy = {
    mode,
    ...(filePath ? { filePath } : directory ? { directory } : {}),
  };
  const current = () =>
    mounted.current &&
    useViewState.getState().openedUin === accountUin &&
    latestIdentity.current === identity;
  async function prepareSave(intent?: ExportSavePolicy): Promise<ExportSavePolicy | null> {
    if (
      !current() ||
      pickInFlight.current ||
      prepareInFlight.current ||
      settings.isLoading ||
      config.isLoading
    )
      return null;
    if (!settings.data) throw new Error('保存偏好读取失败，请重试。');
    if (!binding) throw new Error('账号资料尚未就绪，请重新打开导出工具。');
    prepareInFlight.current = true;
    try {
      let requested = intent ?? policy;
      if (IS_WEB && requested.mode === 'before' && !requested.directory && !requested.filePath) {
        const directory = await new Promise<string | null>((resolve) => {
          resolveServerLocation.current = resolve;
          setServerLocation({ name: '本次导出' });
        });
        if (directory === null || !current()) return null;
        requested = { ...requested, directory: directory || undefined };
      }
      const prepared = await client.bootstrap.prepareExportSave.mutate({
        ...requested,
        ...binding,
      });
      return current() ? prepared : null;
    } finally {
      prepareInFlight.current = false;
    }
  }
  function chooseServerLocation(directory: string | null) {
    resolveServerLocation.current?.(directory);
    resolveServerLocation.current = null;
    setServerLocation(null);
  }
  async function pickDirectory() {
    if (!current() || pickInFlight.current) return;
    pickInFlight.current = true;
    setPicking(true);
    try {
      const directory = await client.bootstrap.pickExportSaveDirectory.mutate();
      if (directory && current()) setOverride({ mode: policy.mode, directory });
    } catch (error) {
      if (current())
        dialog.error('选择保存目录失败', error instanceof Error ? error.message : String(error));
    } finally {
      pickInFlight.current = false;
      if (mounted.current) setPicking(false);
    }
  }
  async function setDefault() {
    if (!current()) return;
    try {
      await client.bootstrap.setExportSaveDefaults.mutate(policy);
      await utils.bootstrap.getSettings.invalidate();
      if (current()) pushToast({ tone: 'success', title: '默认保存方式已更新' });
    } catch (error) {
      if (current())
        dialog.error(
          '更新默认保存方式失败',
          error instanceof Error ? error.message : String(error),
        );
    }
  }
  return {
    settings,
    policy,
    setOverride,
    hasOverride: override !== null,
    picking,
    serverLocation,
    chooseServerLocation,
    prepareSave,
    pickDirectory,
    setDefault,
    accountUin,
    binding,
    isCurrent: current,
  };
}
