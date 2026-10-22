/**
 * native 组件过期时的阻断弹窗。
 *
 * 背景：内置 `nt_helper.node` 带有效期，过期后 `loadNative` 直接抛错、渲染层
 * 拿到 `kind === 'expired'`，用户**进不了主界面**。原来的做法是一个不可关闭的
 * 纯文字错误框，用户除了自己去下载新安装包之外没有出路。
 *
 * 这里把「更新」直接嵌进弹窗：复用 `hooks/useAppUpdate`（与 设置 → 版本 → 软件更新
 * 同一份逻辑），可以就地检查 / 下载 / 重启安装。dev 构建下自更新不可用，给出手动
 * `pnpm native:fetch` 的指引。
 *
 * 不可关闭：构建过期属于硬失败，放行只会让后续所有原生调用继续炸。
 */

import type { ReactElement } from 'react';
import { Download, Gauge, Loader2, RefreshCw, RotateCw, ShieldAlert, Terminal } from 'lucide-react';
import { Modal } from './Dialog';
import { useAppUpdate } from '../hooks/useAppUpdate';

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

/** 「2026-10-16 08:39」；无效返回 null。 */
function fmtDateTime(sec: number | null | undefined): string | null {
  if (!sec) return null;
  const at = new Date(sec * 1000);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

export interface NativeExpiredDialogProps {
  /** 二进制的构建时间（Unix 秒）；未知传 null。 */
  buildTime?: number | null;
  /** 二进制的过期时间（Unix 秒）；未知传 null。 */
  expireTime?: number | null;
  onBackup?: () => void;
}

export function NativeExpiredDialog({
  buildTime,
  expireTime,
  onBackup,
}: NativeExpiredDialogProps): ReactElement {
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

  const pct = progress ? Math.round(progress.percent) : 0;
  const built = fmtDateTime(buildTime);
  const expiredAt = fmtDateTime(expireTime);

  return (
    <Modal labelledBy="weq-native-expired-title" width={420}>
      <div className="weq-dialog weq-dialog-error weq-native-expired">
        <div className="weq-dialog-head">
          <span className="weq-dialog-icon">
            <ShieldAlert size={20} strokeWidth={1.85} aria-hidden />
          </span>
          <h3 id="weq-native-expired-title" className="weq-dialog-title">
            组件版本过旧
          </h3>
        </div>

        <div className="weq-dialog-body">
          <p>
            内置的 QQ 解析组件已超出有效期，WeQ 暂时无法进入主界面。更新到最新版本即可恢复，
            已打开过的账号与数据不受影响。
          </p>
          {built || expiredAt ? (
            <p className="weq-native-expired-times weq-number">
              {built ? <span>构建于 {built}</span> : null}
              {expiredAt ? <span>有效期至 {expiredAt}（已过期）</span> : null}
            </p>
          ) : null}

          {/* 内嵌更新：与 设置 → 版本 同一份逻辑 */}
          <div className="weq-native-expired-update">
            <div className="weq-set-row">
              <div className="weq-set-row-main">
                <span className="weq-set-row-label">
                  {phase === 'available' ? `发现新版本 v${latest}` : '软件更新'}
                </span>
                <span className="weq-set-row-desc weq-number">
                  当前 v{current || '—'}
                  {isDev ? '（开发版）' : ''}
                  {phase === 'available' && latest ? ` → v${latest}` : ''}
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
          </div>

          {isDev ? (
            <p className="weq-set-note weq-number">
              <Terminal size={12} strokeWidth={1.9} aria-hidden /> 开发构建不能自更新：请在本仓库跑{' '}
              <code>pnpm native:fetch</code> 取一份新构建后重启。
            </p>
          ) : null}
          {onBackup ? (
            <button type="button" className="weq-set-btn" onClick={onBackup}>
              备份与恢复
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
