/**
 * 应用内更新的渲染层状态机（检查 → 下载 → 安装）。
 *
 * 从 `components/settings/UpdateCard.tsx` 抽出来，供两处共用：
 *   - 设置 → 版本 → 软件更新卡片；
 *   - native 构建过期时那张阻断弹窗（用户进不了主界面，必须在弹窗里就能更新）。
 *
 * 后端动作走 `update.check` / `update.download` / `update.install`，进度与生命周期
 * 走 `update.onProgress` / `update.onEvent` 订阅。dev（未打包）下只能检查。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trpc, client } from '../trpc/client';
import { useDialog } from '../components/Dialog';
import { useTabActive } from '../components/RetainedTabs';
import { useUpdateStore } from '../state/update';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'uptodate'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface AppUpdate {
  includePrerelease: boolean;
  changingPrerelease: boolean;
  setPrerelease(enabled: boolean): Promise<void>;
  phase: UpdatePhase;
  /** 最新版本号（发现更新后可用），否则 null。 */
  latest: string | null;
  /** 当前运行版本。 */
  current: string;
  progress: UpdateProgress | null;
  /** 选中的加速站标签（如 `gh-proxy.com`），未知为 ''。 */
  mirrorName: string;
  /** 正在测速的镜像数，null 表示不在测速。 */
  mirrorCount: number | null;
  isDev: boolean;
  /**
   * False when a distro package manager owns this install (AUR): the card still
   * checks versions but sends the user to `paru -Syu` instead of downloading.
   */
  isManaged: boolean;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
}

/** `https://gh-proxy.com/https://github.com/.../download` → `gh-proxy.com`。 */
export function mirrorLabel(base: string | null): string {
  if (!base) return '';
  const stripped = base.replace('https://github.com/weq-devs/WeQ/releases/latest/download', '');
  if (!stripped) return 'github.com（直连）';
  try {
    const host = new URL(stripped).host;
    return host === 'github.com' ? 'github.com（直连）' : host;
  } catch {
    return stripped.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useAppUpdate(): AppUpdate {
  const utils = trpc.useContext();
  const active = useTabActive();
  const showError = useDialog((s) => s.showError);

  const version = trpc.bootstrap.getVersionInfo.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const state = trpc.update.getState.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const checkMut = trpc.update.check.useMutation();
  const preferences = trpc.update.getPrerelease.useQuery(undefined, {
    enabled: active,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const preferenceMut = trpc.update.setPrerelease.useMutation();
  const downloadMut = trpc.update.download.useMutation();
  const installMut = trpc.update.install.useMutation();

  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [includePrerelease, setIncludePrerelease] = useState(false);
  useEffect(() => {
    setIncludePrerelease(preferences.data === true);
  }, [preferences.data]);
  const [latest, setLatest] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [mirror, setMirror] = useState<string | null>(null);
  const [mirrorCount, setMirrorCount] = useState<number | null>(null);
  const installPending = useRef(false);

  const isDev = version.data?.isDev ?? false;
  // 包管理器托管的副本（AUR）由后端在检查结果里标记；未检查过时按普通安装处理，
  // 免得把正常的 Windows / macOS 用户误判成 AUR 版。
  const isManaged = state.data?.managed === true;
  const current = version.data?.app ?? state.data?.current ?? '';

  // Seed from the last cached check (the startup background check may already
  // have found something).
  useEffect(() => {
    const s = state.data;
    if (s?.base) setMirror(s.base);
    if (s?.hasUpdate && s.latest) {
      setLatest(s.latest);
      setPhase((p) => (p === 'idle' ? 'available' : p));
    }
  }, [state.data]);

  // Live progress + lifecycle.
  const observe =
    active || phase === 'checking' || phase === 'downloading' || phase === 'installing';
  useEffect(() => {
    if (!observe) return;
    let current = true;
    const ps = client.update.onProgress.subscribe(undefined, {
      onData: (p) => {
        if (current) setProgress(p);
      },
      onError: (err) => console.error('[update] progress subscription error', err),
    });
    const es = client.update.onEvent.subscribe(undefined, {
      onData: (e) => {
        if (!current) return;
        if (e.kind === 'checking') {
          setMirrorCount(e.mirrors);
          setPhase((p) => (p === 'idle' ? 'checking' : p));
        } else if (e.kind === 'chosen') {
          setMirror(e.base);
          setLatest(e.latest);
          setMirrorCount(null);
          // A non-forced check with no update has no other terminal event, so
          // resolve the "checking" phase here rather than spinning forever.
          setPhase((p) => (p === 'checking' ? (e.hasUpdate ? 'available' : 'uptodate') : p));
        } else if (e.kind === 'available') {
          setLatest(e.latest);
          setPhase((p) =>
            p === 'downloading' || p === 'downloaded' || p === 'installing' ? p : 'available',
          );
        } else if (e.kind === 'downloaded') {
          setProgress(null);
          setPhase((p) => (p === 'installing' ? p : 'downloaded'));
        } else if (e.kind === 'installing') {
          installPending.current = true;
          setPhase('installing');
        } else if (e.kind === 'error') {
          installPending.current = false;
          setProgress(null);
          setPhase((p) => (p === 'installing' ? 'downloaded' : p === 'downloading' ? 'error' : p));
          showError('更新失败', e.message);
        }
      },
      onError: (err) => console.error('[update] event subscription error', err),
    });
    return () => {
      current = false;
      ps.unsubscribe();
      es.unsubscribe();
    };
  }, [showError, observe]);

  const check = useCallback(async (): Promise<void> => {
    setPhase('checking');
    try {
      const r = await checkMut.mutateAsync();
      if (r.hasUpdate && r.latest) {
        setLatest(r.latest);
        setPhase('available');
      } else {
        setPhase('uptodate');
      }
    } catch (e) {
      setPhase('error');
      showError('检查更新失败', errMsg(e));
    }
  }, [checkMut, showError]);

  const setPrerelease = useCallback(
    async (enabled: boolean): Promise<void> => {
      try {
        const saved = await preferenceMut.mutateAsync({ enabled });
        utils.update.getPrerelease.setData(undefined, saved);
        utils.update.getState.setData(undefined, null);
        setIncludePrerelease(saved);
        setPhase('idle');
        setLatest(null);
        setMirror(null);
        useUpdateStore.getState().clear();
      } catch (error) {
        showError('保存更新设置失败', errMsg(error));
      }
    },
    [preferenceMut, showError, utils],
  );

  const download = useCallback(async (): Promise<void> => {
    setMirrorCount(null);
    setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    setPhase('downloading');
    try {
      await downloadMut.mutateAsync();
    } catch (e) {
      setProgress(null);
      setPhase('error');
      showError('启动下载失败', errMsg(e));
    }
  }, [downloadMut, showError]);

  const install = useCallback(async (): Promise<void> => {
    if (installPending.current) return;
    installPending.current = true;
    setPhase('installing');
    try {
      await installMut.mutateAsync();
    } catch (e) {
      const needsError = installPending.current;
      installPending.current = false;
      setPhase('downloaded');
      if (needsError) showError('安装失败', errMsg(e));
    }
  }, [installMut, showError]);

  return useMemo(
    () => ({
      includePrerelease,
      changingPrerelease: preferenceMut.isLoading || preferences.isLoading,
      setPrerelease,
      phase,
      latest,
      current,
      progress,
      mirrorName: mirrorLabel(mirror),
      mirrorCount,
      isDev,
      isManaged,
      check,
      download,
      install,
    }),
    [
      phase,
      includePrerelease,
      preferenceMut.isLoading,
      preferences.isLoading,
      setPrerelease,
      latest,
      current,
      progress,
      mirror,
      mirrorCount,
      isDev,
      isManaged,
      check,
      download,
      install,
    ],
  );
}
