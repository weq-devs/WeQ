/**
 * 设置 → 版本 → 软件更新.
 *
 * 检查 / 下载 / 安装应用内更新。逻辑收在 `hooks/useAppUpdate` 里（过期弹窗复用同一份），
 * 这里只负责渲染。下载进度复用 `weq-set-progress-*` 样式。
 *
 * dev（未打包）下仅可检查；下载/安装会被后端拒绝，故按钮禁用并提示。
 */

import { CheckCircle2, Download, Gauge, Loader2, RefreshCw, RotateCw, Save } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { isUpdateCheckInterval } from '@weq/service/update-settings';
import { useAppUpdate } from '../../hooks/useAppUpdate';
import { useDialog } from '../Dialog';
import { Card, Row, Toggle } from './controls';
import '../../styles/update-settings.css';

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
    intervalMinutes,
    changingInterval,
    setIntervalMinutes,
    includePrerelease,
    changingPrerelease,
    setPrerelease,
    phase,
    latest,
    current,
    progress,
    mirrorName,
    mirrorCount,
    isDev,
    isManaged,
    check,
    download,
    install,
  } = useAppUpdate();
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null);
  const showError = useDialog((s) => s.showError);
  const intervalValue = intervalDraft ?? String(intervalMinutes);
  const minutes = intervalValue.trim() === '' ? NaN : Number(intervalValue);
  const canSaveInterval =
    !changingInterval && isUpdateCheckInterval(minutes) && minutes !== intervalMinutes;
  async function saveInterval(): Promise<void> {
    if (!canSaveInterval) return;
    try {
      await setIntervalMinutes(minutes);
      setIntervalDraft(null);
    } catch (error) {
      showError('保存更新设置失败', error instanceof Error ? error.message : String(error));
    }
  }

  const hasNew =
    phase === 'available' ||
    phase === 'downloading' ||
    phase === 'downloaded' ||
    phase === 'installing';
  const pct = progress ? Math.round(progress.percent) : 0;

  const label = hasNew
    ? `发现新版本 v${latest}`
    : phase === 'uptodate'
      ? '已是最新版本'
      : '软件更新';

  return (
    <Card title="软件更新" icon={<Download size={15} strokeWidth={1.8} />}>
      <Row
        settingId="update-check-interval"
        label="自动检查更新频率"
        desc="单位：分钟；-1 表示永不"
        control={
          <div className="weq-update-interval-control">
            <input
              type="number"
              className="weq-set-input"
              aria-label="自动检查更新频率（分钟）"
              min={-1}
              step="any"
              value={intervalValue}
              disabled={changingInterval}
              aria-invalid={!isUpdateCheckInterval(minutes)}
              onChange={(event) => setIntervalDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveInterval();
                }
              }}
            />
            <button
              type="button"
              className="weq-set-iconbtn"
              aria-label="保存自动检查更新频率"
              title="保存自动检查更新频率"
              disabled={!canSaveInterval}
              onClick={() => void saveInterval()}
            >
              {changingInterval ? <Loader2 size={16} className="weq-spin" /> : <Save size={16} />}
            </button>
          </div>
        }
      />
      <Row
        settingId="update-prerelease"
        label="检查测试版"
        control={
          <Toggle
            label="检查测试版"
            checked={includePrerelease}
            disabled={
              changingPrerelease || ['checking', 'downloading', 'installing'].includes(phase)
            }
            onChange={(enabled) => void setPrerelease(enabled)}
          />
        }
      />
      <div className="weq-set-row">
        <div className="weq-set-row-main">
          <span
            className="weq-set-row-label"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {phase === 'uptodate' ? (
              <CheckCircle2 size={14} strokeWidth={2} aria-hidden style={{ flexShrink: 0 }} />
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
          {phase === 'installing' ? (
            <button type="button" className="weq-set-btn" disabled aria-busy="true">
              <Loader2 size={14} strokeWidth={2} className="weq-spin" aria-hidden />
              正在重启…
            </button>
          ) : phase === 'downloaded' ? (
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
              disabled={isDev || isManaged}
              title={
                isDev
                  ? '开发模式不支持自更新'
                  : isManaged
                    ? '当前版本由系统包管理器安装，请用 paru -Syu 更新'
                    : undefined
              }
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
          : isManaged
            ? '当前版本由系统包管理器（AUR）安装：请用 paru -Syu 或 pacman -Syu 更新，应用内不接管安装。'
            : '更新通过 GitHub 加速站自动测速下载，无需手动下载安装包。'}
      </p>
    </Card>
  );
}
