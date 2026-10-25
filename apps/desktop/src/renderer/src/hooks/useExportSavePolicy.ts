import { useEffect, useRef, useState } from 'react';
import type { ExportSavePolicy, ExportOutputPlan } from '@weq/service';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { IS_WEB } from '../lib/target';

/** 所有保存入口只跟随全局设置；已准备的位置仅用于当前请求，不保留页面覆盖。 */
export function useExportSavePolicy() {
  const settings = trpc.bootstrap.getSettings.useQuery();
  const accountUin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: Boolean(accountUin),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const binding =
    accountUin && config.data?.uin === accountUin && config.data.configId
      ? Object.freeze({
          expectedAccountUin: accountUin,
          expectedAccountConfigId: config.data.configId,
        })
      : null;
  const identity = `${accountUin ?? ''}:${binding?.expectedAccountConfigId ?? ''}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const mounted = useRef(true);
  const prepareInFlight = useRef(false);
  const [picking, setPicking] = useState(false);
  const [serverLocation, setServerLocation] = useState<{ name: string } | null>(null);
  const resolveServerLocation = useRef<((directory: string | null) => void) | null>(null);
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
  const mode = settings.data?.exportSaveMode ?? 'before';
  const policy: ExportSavePolicy = {
    mode,
    ...(mode === 'preset' && settings.data?.defaultExportDir
      ? { directory: settings.data.defaultExportDir }
      : {}),
  };
  const current = () =>
    mounted.current &&
    useViewState.getState().openedUin === accountUin &&
    latestIdentity.current === identity;
  async function prepareSave(
    _intent?: ExportSavePolicy,
    output?: ExportOutputPlan,
  ): Promise<ExportSavePolicy | null> {
    if (!current() || prepareInFlight.current || settings.isLoading || config.isLoading)
      return null;
    if (!settings.data) throw new Error('保存偏好读取失败，请重试。');
    if (!binding) throw new Error('账号资料尚未就绪，请重新打开导出工具。');
    prepareInFlight.current = true;
    setPicking(true);
    try {
      let requested = { ...policy };
      const frozenOutput = output ? structuredClone(output) : undefined;
      if (IS_WEB && requested.mode === 'before') {
        const directory = await new Promise<string | null>((resolve) => {
          resolveServerLocation.current = resolve;
          setServerLocation({ name: frozenOutput?.name ?? '本次导出' });
        });
        if (directory === null || !current()) return null;
        requested = { ...requested, directory: directory || undefined };
      }
      const prepared = await client.bootstrap.prepareExportSave.mutate({
        ...requested,
        ...binding,
        ...(frozenOutput ? { output: frozenOutput } : {}),
      });
      return current() ? prepared : null;
    } finally {
      prepareInFlight.current = false;
      if (mounted.current) setPicking(false);
    }
  }
  function chooseServerLocation(directory: string | null) {
    resolveServerLocation.current?.(directory);
    resolveServerLocation.current = null;
    setServerLocation(null);
  }
  return {
    settings,
    policy,
    picking,
    serverLocation,
    chooseServerLocation,
    prepareSave,
    accountUin,
    binding,
    isCurrent: current,
  };
}
