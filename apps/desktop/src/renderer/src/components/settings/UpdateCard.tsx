/**
 * 设置 → 版本 → 软件更新.
 *
 * 检查 / 下载 / 安装应用内更新。逻辑收在 `hooks/useAppUpdate` 里（过期弹窗复用同一份），
 * 这里只负责渲染。下载进度复用 `weq-set-progress-*` 样式。
 *
 * dev（未打包）下仅可检查；下载/安装会被后端拒绝，故按钮禁用并提示。
 */

import { NumericText } from '../NumericText';
import {
  CheckCircle2,
  Download,
  Gauge,
  ListTodo,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
} from 'lucide-react';
import { AutoSave } from './AutoSave';
import type { ReactElement } from 'react';
import { useNumericSettingDraft } from './useNumericSettingDraft';
import { isUpdateCheckInterval } from '@weq/service/update-settings';
import { useAppUpdate } from '../../hooks/useAppUpdate';
import { Card, Row, Toggle } from './controls';
import { TaskProgressBar } from '../tasks/TaskProgressBar';
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
    intervalReady,
    setIntervalMinutes,
    includePrerelease,
    changingPrerelease,
    setPrerelease,
    phase,
    latest,
    current,
    progress,
    downloadTask,
    controllingDownload,
    controlDownload,
    mirrorName,
    mirrorCount,
    isDev,
    isManaged,
    check,
    download,
    install,
  } = useAppUpdate(true);
  const [intervalValue, setIntervalDraft] = useNumericSettingDraft(
    'update:interval',
    intervalReady ? intervalMinutes : undefined,
    intervalMinutes,
  );
  const minutes = intervalValue.trim() === '' ? NaN : Number(intervalValue);

  const hasNew =
    phase === 'available' ||
    phase === 'downloading' ||
    phase === 'paused' ||
    (phase === 'error' && downloadTask?.status === 'failed') ||
    phase === 'downloaded' ||
    phase === 'installing';
  const pct = progress ? Math.round(progress.percent) : 0;
  const canPause =
    phase === 'downloading' && downloadTask?.actions.some((action) => action.id === 'pause');
  const canContinue =
    phase === 'paused' && downloadTask?.actions.some((action) => action.id === 'continue');
  const canRetry =
    phase === 'error' && downloadTask?.actions.some((action) => action.id === 'retry');

  const label = hasNew ? '有可用更新' : phase === 'uptodate' ? '已是最新版本' : null;

  return (
    <Card
      settingId="software-update"
      title="软件更新"
      icon={<Download size={15} strokeWidth={1.8} />}
    >
      <Row
        settingId="update-check-interval"
        desc="单位：分钟；-1 表示永不"
        control={
          <AutoSave
            resetKeys={['interval']}
            value={intervalValue.trim() ? Number(intervalValue) : ''}
            saved={intervalMinutes}
            ready={intervalReady}
            valid={isUpdateCheckInterval(minutes)}
            save={async (text) => {
              await setIntervalMinutes(Number(text));
            }}
            reset={() => setIntervalDraft(String(intervalMinutes))}
          >
            <div className="weq-update-interval-control">
              <input
                type="number"
                className="weq-set-input"
                aria-label="自动检查更新频率（分钟）"
                min={-1}
                step="any"
                value={intervalValue}
                disabled={!intervalReady}
                aria-invalid={!isUpdateCheckInterval(minutes)}
                onChange={(event) => setIntervalDraft(event.target.value)}
              />
            </div>
          </AutoSave>
        }
      />
      <Row
        settingId="update-prerelease"
        control={
          <Toggle
            label="检查测试版"
            checked={includePrerelease}
            disabled={
              changingPrerelease ||
              ['checking', 'downloading', 'paused', 'installing'].includes(phase)
            }
            onChange={(enabled) => void setPrerelease(enabled)}
          />
        }
      />
      <div className="weq-set-row">
        <div className="weq-set-row-main">
          {label ? (
            <span
              className="weq-set-row-label"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {phase === 'uptodate' ? (
                <CheckCircle2 size={14} strokeWidth={2} aria-hidden style={{ flexShrink: 0 }} />
              ) : null}
              {label}
            </span>
          ) : null}
          <span className="weq-set-row-desc">
            <NumericText>{`当前 v${current || '—'}${isDev ? '（开发版）' : ''}${hasNew && latest ? ` → v${latest}` : ''}`}</NumericText>
          </span>
        </div>
        <div className="weq-set-row-ctrl weq-update-actions">
          {downloadTask?.foreground && (phase === 'downloading' || phase === 'paused') ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={controllingDownload}
              onClick={() => void controlDownload('background')}
            >
              <ListTodo size={14} aria-hidden />
              后台进行
            </button>
          ) : null}
          {phase === 'installing' ? (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-primary"
              disabled
              aria-busy="true"
            >
              <Loader2 size={14} strokeWidth={2} className="weq-spin" aria-hidden />
              正在重启…
            </button>
          ) : phase === 'downloaded' ? (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-primary"
              onClick={() => void install()}
            >
              <RotateCw size={14} strokeWidth={1.8} aria-hidden />
              重启并安装
            </button>
          ) : canPause || canContinue || canRetry ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={controllingDownload || isDev || isManaged}
              onClick={() =>
                void controlDownload(canPause ? 'pause' : canContinue ? 'continue' : 'retry')
              }
            >
              {canPause ? (
                <Pause size={14} aria-hidden />
              ) : canContinue ? (
                <Play size={14} aria-hidden />
              ) : (
                <RefreshCw size={14} aria-hidden />
              )}
              {canPause ? '暂停下载' : canContinue ? '继续下载' : '重试下载'}
            </button>
          ) : phase === 'downloading' ? (
            <button type="button" className="weq-set-btn weq-set-btn-primary" disabled>
              <Loader2 size={14} strokeWidth={2} className="weq-spin" aria-hidden />
              {downloadTask?.statusLabel ?? '下载中…'}
            </button>
          ) : phase === 'available' ? (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-primary"
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
              {phase === 'checking' ? (
                mirrorCount ? (
                  <NumericText>{`测速中（${mirrorCount} 个源）`}</NumericText>
                ) : (
                  '检查中'
                )
              ) : (
                '检查更新'
              )}
            </button>
          )}
          {canRetry ? (
            <button
              type="button"
              className="weq-set-btn"
              onClick={() => void check()}
              disabled={controllingDownload}
            >
              检查更新
            </button>
          ) : null}
        </div>
      </div>

      {phase === 'downloading' || phase === 'paused' ? (
        <div className="weq-set-progress">
          <TaskProgressBar
            value={progress?.total ? pct : undefined}
            status={phase === 'paused' ? 'paused' : 'running'}
            label="更新下载进度"
          />
          <div className="weq-set-progress-meta weq-number">
            <span role="status">
              {phase === 'paused'
                ? (downloadTask?.statusLabel ?? '已暂停')
                : progress?.total
                  ? `${pct}%`
                  : '正在准备下载'}
            </span>
            {progress?.total ? (
              <span>
                {fmtBytes(progress.transferred)} / {fmtBytes(progress.total)}
                {phase === 'downloading' && progress.bytesPerSecond > 0
                  ? ` · ${fmtSpeed(progress.bytesPerSecond)}`
                  : ''}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {phase === 'error' && downloadTask?.status === 'failed' && downloadTask.note ? (
        <p className="weq-set-note" role="alert">
          {downloadTask.note}
        </p>
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
            {phase !== 'downloading' ? '（已测速）' : null}
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
