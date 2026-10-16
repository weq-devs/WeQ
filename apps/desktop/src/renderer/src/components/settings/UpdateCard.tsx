/**
 * 设置 → 版本 → 软件更新.
 *
 * 检查 / 下载 / 安装应用内更新。逻辑收在 `hooks/useAppUpdate` 里（过期弹窗复用同一份），
 * 这里只负责渲染。下载进度复用 `weq-set-progress-*` 样式。
 *
 * dev（未打包）下仅可检查；下载/安装会被后端拒绝，故按钮禁用并提示。
 */

import { CheckCircle2, Download, Gauge, Loader2, RefreshCw, RotateCw } from 'lucide-react';
import type { ReactElement } from 'react';
import { useAppUpdate } from '../../hooks/useAppUpdate';
import { Card } from './controls';

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

export function UpdateCard(): ReactElement {
  const {
    phase,
    latest,
    current,
    progress,
    mirrorName,
    mirrorCount,
    isDev,
    check,
    download,
    install,
  } = useAppUpdate();

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
            <button type="button" className="weq-set-btn" onClick={() => void install()}>
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
              onClick={() => void download()}
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
              onClick={() => void check()}
              disabled={phase === 'checking'}
            >
              {phase === 'checking' ? (
                <Loader2 size={14} strokeWidth={2} className="weq-spin" aria-hidden />
              ) : (
                <RefreshCw size={14} strokeWidth={1.8} aria-hidden />
              )}
              {phase === 'checking'
                ? mirrorCount
                  ? `测速中（${mirrorCount} 个源）`
                  : '检查中'
                : '检查更新'}
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

      {/* 自动选择是黑盒 —— 把测速结果和选中的加速站显式展示出来。 */}
      {mirrorName &&
      (phase === 'available' || phase === 'downloading' || phase === 'downloaded') ? (
        <div className="weq-set-mirror">
          {phase === 'downloading' ? (
            <Loader2 size={12} strokeWidth={2} className="weq-spin" aria-hidden />
          ) : (
            <Gauge size={12} strokeWidth={1.8} aria-hidden />
          )}
          <span>
            已自动选择加速站 <b>{mirrorName}</b>
            {phase === 'downloading' ? ' · 正在下载' : '（已测速）'}
          </span>
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
