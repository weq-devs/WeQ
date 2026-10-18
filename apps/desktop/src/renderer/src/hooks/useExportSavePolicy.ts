import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ExportSavePolicy } from '@weq/service';
import { client, trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { useToast } from '../components/Toast';
import { useViewState } from '../state/view';

/** 导出与资源下载共用保存准备；单次参数不自动覆盖全局默认。 */
export function useExportSavePolicy() {
  const settings = trpc.bootstrap.getSettings.useQuery();
  const utils = trpc.useUtils();
  const dialog = useAppDialog();
  const pushToast = useToast((state) => state.push);
  const accountUin = useViewState((state) => state.openedUin);
  const mounted = useRef(true);
  const pickInFlight = useRef(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<{
    override: ExportSavePolicy | null;
    directories: Partial<Record<'preset' | 'before', string>>;
  }>({ override: null, directories: {} });
  const { override } = draft;
  // 每种模式保留本次目录，模式切换不把 Web 子目录当成预设，也不丢临时覆盖。
  const setOverride: Dispatch<SetStateAction<ExportSavePolicy | null>> = (action) => {
    setDraft((previous) => {
      const next = typeof action === 'function' ? action(previous.override) : action;
      if (!next) return { override: null, directories: {} };
      const directories = { ...previous.directories };
      if (next.mode !== 'after') {
        if (next.directory) directories[next.mode] = next.directory;
        else if (previous.override?.mode === next.mode) delete directories[next.mode];
      }
      const directory = next.mode === 'after' ? undefined : directories[next.mode];
      return { override: { mode: next.mode, ...(directory ? { directory } : {}) }, directories };
    });
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mode = override?.mode ?? settings.data?.exportSaveMode ?? 'after';
  const directory =
    mode === 'preset'
      ? (override?.directory ?? draft.directories.preset ?? settings.data?.defaultExportDir)
      : mode === 'before'
        ? (override?.directory ?? draft.directories.before)
        : undefined;
  const policy: ExportSavePolicy = { mode, ...(directory ? { directory } : {}) };
  const current = () => mounted.current && useViewState.getState().openedUin === accountUin;
  async function prepareSave(): Promise<ExportSavePolicy | null> {
    if (!current() || pickInFlight.current) return null;
    const prepared = await client.bootstrap.prepareExportSave.mutate(policy);
    return current() ? prepared : null;
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
    prepareSave,
    pickDirectory,
    setDefault,
    accountUin,
    isCurrent: current,
  };
}
