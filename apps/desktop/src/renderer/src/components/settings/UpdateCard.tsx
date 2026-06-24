/**
 * 设置 → 全局设置 → 软件更新.
 *
 * 检查 / 下载 / 安装应用内更新。检查走加速站测速（`update.check`），下载+静默
 * 安装走 electron-updater（`update.download` / `update.install`）。下载进度复用
 * 语音模型下载那套 `weq-set-progress-*` 样式 + 订阅范式。
 *
 * dev（未打包）下仅可检查；下载/安装会被后端拒绝，故按钮禁用并提示。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, RotateCw } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { Card } from './controls';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function fmtSpeed(bps: number): string {
  if (!bps || bps <= 0) return '';
  const mb = bps / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

type Phase =
  | 'idle'
  | 'checking'
  | 'uptodate'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface Progress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export function UpdateCard(): ReactElement {
  const showError = useDialog((s) => s.showError);

  const version = trpc.bootstrap.getVersionInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const state = trpc.update.getState.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const check = trpc.update.check.useMutation();
  const download = trpc.update.download.useMutation();
  const install = trpc.update.install.useMutation();

  const [phase, setPhase] = useState<Phase>('idle');
  const [latest, setLatest] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  const isDev = version.data?.isDev ?? false;
  const current = version.data?.app ?? state.data?.current ?? '';

  // Seed from the last cached check (the startup background check may already
  // have found something).
  useEffect(() => {
    const s = state.data;
    if (s?.hasUpdate && s.latest) {
      setLatest(s.latest);
      setPhase((p) => (p === 'idle' ? 'available' : p));
    }
  }, [state.data]);

  // Live progress + lifecycle. Mirrors VoiceTranscribeSection's subscription.
  useEffect(() => {
    const ps = client.update.onProgress.subscribe(undefined, {
      onData: (p) => setProgress(p),
      onError: (err) => console.error('[update] progress subscription error', err),
    });
    const es = client.update.onEvent.subscribe(undefined, {
      onData: (e) => {
        if (e.kind === 'available') {
          setLatest(e.latest);
          setPhase((p) => (p === 'downloading' || p === 'downloaded' ? p : 'available'));
        } else if (e.kind === 'downloaded') {
          setProgress(null);
          setPhase('downloaded');
        } else if (e.kind === 'error') {
          setProgress(null);
          setPhase((p) => (p === 'downloading' ? 'error' : p));
          showError('更新失败', e.message);
        }
      },
      onError: (err) => console.error('[update] event subscription error', err),
    });
    return () => {
      ps.unsubscribe();
      es.unsubscribe();
    };
  }, [showError]);

  async function onCheck(): Promise<void> {
    setPhase('checking');
    try {
      const r = await check.mutateAsync();
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
  }

  async function onDownload(): Promise<void> {
    setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    setPhase('downloading');
    try {
      await download.mutateAsync();
    } catch (e) {
      setProgress(null);
      setPhase('error');
      showError('启动下载失败', errMsg(e));
    }
  }

  async function onInstall(): Promise<void> {
    try {
      await install.mutateAsync();
    } catch (e) {
      showError('安装失败', errMsg(e));
    }
  }

  const hasNew = phase === 'available' || phase === 'downloading' || phase === 'downloaded';
  const pct = progress ? Math.round(progress.percent) : 0;

  const label = hasNew
    ? `发现新版本 v${latest}`
    : phase === 'uptodate'
      ? '已是最新版本'
      : '软件更新';

  return (
    <Card title="软件更新">
      <div className="weq-set-row">
        <div className="weq-set-row-main">
          <span className="weq-set-row-label">
            {phase === 'uptodate' ? (
              <CheckCircle2
                size={14}
                strokeWidth={2}
                aria-hidden
                style={{ verticalAlign: '-2px', marginRight: 4 }}
              />
            ) : null}
            {label}
          </span>
          <span className="weq-set-row-desc weq-number">
            当前 v{current || '—'}
            {isDev ? '（开发版）' : ''}
            {hasNew && latest ? ` → v${latest}` : ''}
          </span>
        </div>
        <div className="weq-set-row-ctrl">
          {phase === 'downloaded' ? (
            <button
              type="button"
              className="weq-set-btn"
              onClick={() => void onInstall()}
              disabled={install.isLoading}
            >
              <RotateCw size={14} strokeWidth={1.8} aria-hidden />
              重启并安装
            </button>
          ) : phase === 'downloading' ? (
            <button type="button" className="weq-set-btn" disabled>
              <Loader2 size={14} strokeWidth={2} className="weq-spin" aria-hidden />
              下载中 {pct}%
            </button>
          ) : phase === 'available' ? (
            <button
              type="button"
              className="weq-set-btn"
              onClick={() => void onDownload()}
              disabled={isDev}
              title={isDev ? '开发模式不支持自更新' : undefined}
            >
              <Download size={14} strokeWidth={1.8} aria-hidden />
              立即更新
            </button>
          ) : (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft"
              onClick={() => void onCheck()}
              disabled={phase === 'checking'}
            >
              {phase === 'checking' ? (
                <Loader2 size={14} strokeWidth={2} className="weq-spin" aria-hidden />
              ) : (
                <RefreshCw size={14} strokeWidth={1.8} aria-hidden />
              )}
              {phase === 'checking' ? '检查中' : '检查更新'}
            </button>
          )}
        </div>
      </div>

      {phase === 'downloading' && progress ? (
        <div className="weq-set-progress">
          <div className="weq-set-progress-track">
            <div className="weq-set-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="weq-set-progress-meta weq-number">
            <span>{pct}%</span>
            <span>
              {fmtBytes(progress.transferred)} / {fmtBytes(progress.total)}
              {progress.bytesPerSecond > 0 ? ` · ${fmtSpeed(progress.bytesPerSecond)}` : ''}
            </span>
          </div>
        </div>
      ) : null}

      <p className="weq-set-note">
        {isDev
          ? '开发模式仅可检查更新；自动下载安装需使用打包后的安装版。'
          : '更新通过 GitHub 加速站自动测速下载，无需手动下载安装包。'}
      </p>
    </Card>
  );
}
