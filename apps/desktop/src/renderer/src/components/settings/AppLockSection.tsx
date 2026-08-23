/**
 * 设置 → 应用锁.
 *
 * 应用锁总开关、解锁方式（WeQ 验证器 RFC 6238 TOTP / Windows Hello）、
 * 验证器绑定（二维码 + 密钥 + 6 位码确认，在独立弹窗中完成）、空闲自动锁定。
 */

import { useState, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  Smartphone,
  Unlink,
} from 'lucide-react';
import type { AppLockMethod } from '@weq/service';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { shellBridge } from '../../lib/target';
import {
  fetchSystemAuthStatus,
  fetchTotpStatus,
  SYSTEM_AUTH_STATUS_QUERY_KEY,
  TOTP_STATUS_QUERY_KEY,
} from '../../lib/appLockStatus';
import { TotpBindDialog } from './TotpBindDialog';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 空闲自动锁定时长选项。0 = 关闭（仍可手动上锁）。 */
const AUTO_LOCK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '关闭' },
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
  { value: 30, label: '30 分钟' },
];

export function AppLockSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);
  const pushToast = useToast((s) => s.push);
  const queryClient = useQueryClient();

  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setEnabled = trpc.bootstrap.setAppLockEnabled.useMutation();
  const setMethod = trpc.bootstrap.setAppLockMethod.useMutation();
  const setAutoLock = trpc.bootstrap.setAutoLockMinutes.useMutation();

  // 与左栏上锁按钮、锁屏遮罩共用同一查询；绑定 / 解绑后 invalidate 即时同步。
  const systemAuthQuery = useQuery({
    queryKey: SYSTEM_AUTH_STATUS_QUERY_KEY,
    queryFn: fetchSystemAuthStatus,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const totpQuery = useQuery({
    queryKey: TOTP_STATUS_QUERY_KEY,
    queryFn: fetchTotpStatus,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const [bindOpen, setBindOpen] = useState(false);

  const appLock = settings.data?.appLock;
  const enabled = appLock?.enabled ?? true;
  const method = appLock?.method ?? 'totp';
  const autoLockMinutes = settings.data?.autoLockMinutes ?? 0;
  const systemAvailable = systemAuthQuery.data?.available === true;
  const totpConfigured = totpQuery.data?.configured === true;

  const methodReady = method === 'system' ? systemAvailable : totpConfigured;
  const autoLockBlockReason = !enabled
    ? '请先开启应用锁。'
    : !methodReady
      ? method === 'system'
        ? (systemAuthQuery.data?.error ?? '当前设备系统认证不可用。')
        : '请先完成 WeQ 验证器绑定。'
      : '';
  const canAutoLock = enabled && methodReady;

  async function onToggleEnabled(next: boolean): Promise<void> {
    try {
      await setEnabled.mutateAsync({ enabled: next });
      await settings.refetch();
    } catch (e) {
      showError('保存失败', errMsg(e));
    }
  }

  async function onSetMethod(next: AppLockMethod): Promise<void> {
    if (next === 'system' && !systemAvailable) {
      showError(
        '无法使用系统认证',
        systemAuthQuery.data?.error ?? '当前设备不支持或未启用系统认证。',
      );
      return;
    }
    try {
      await setMethod.mutateAsync({ method: next });
      await settings.refetch();
    } catch (e) {
      showError('保存失败', errMsg(e));
    }
  }

  async function onSetAutoLock(minutes: number): Promise<void> {
    if (minutes > 0 && !canAutoLock) {
      showError('无法开启自动锁定', autoLockBlockReason || '当前解锁方式暂不可用。');
      return;
    }
    try {
      await setAutoLock.mutateAsync({ minutes });
      await settings.refetch();
    } catch (e) {
      showError('保存自动锁定设置失败', errMsg(e));
    }
  }

  async function onRebind(): Promise<void> {
    const ok = await confirm(
      '重新绑定验证器',
      '重新绑定会生成全新的密钥，当前验证器 App 中的条目将立即失效。若应用锁已开启，请先在新验证器 App 中完成添加，再继续。是否继续？',
      { okLabel: '重新绑定', cancelLabel: '取消', tone: 'warning' },
    );
    if (!ok) return;
    setBindOpen(true);
  }

  async function onUnbind(): Promise<void> {
    const ok = await confirm(
      '解除验证器绑定',
      '解除后无法再用 WeQ 验证器解锁。若解锁方式仍是验证器，请先切换到 Windows Hello 或完成重新绑定，否则将无法上锁。是否继续？',
      { okLabel: '解除绑定', cancelLabel: '取消', tone: 'warning' },
    );
    if (!ok) return;
    try {
      const b = shellBridge();
      await b?.totp.remove();
      await queryClient.invalidateQueries({ queryKey: TOTP_STATUS_QUERY_KEY });
      pushToast({ tone: 'success', title: '已解除', message: 'WeQ 验证器已解除绑定' });
    } catch (e) {
      showError('解除绑定失败', errMsg(e));
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader
        title="应用锁"
        desc="上锁后需要验证才能继续访问当前账号数据，左栏头像上方可随时手动上锁。"
        icon={<LockKeyhole size={16} strokeWidth={1.8} />}
      />

      <Card title="应用锁">
        <Row
          label="启用应用锁"
          desc={
            enabled
              ? '开启后可在左栏头像上方手动上锁，空闲超时也会自动上锁。'
              : '关闭后手动上锁与空闲自动上锁都不生效。'
          }
          control={
            <Toggle
              checked={enabled}
              disabled={settings.isLoading || setEnabled.isLoading}
              onChange={(next) => void onToggleEnabled(next)}
              label="启用应用锁"
            />
          }
        />
        {enabled && method === 'totp' && !totpConfigured ? (
          <p className="weq-applock-warn">
            <AlertTriangle size={13} aria-hidden />
            应用锁已开启但验证器尚未绑定，请先在下方完成绑定，否则将无法上锁。
          </p>
        ) : null}
      </Card>

      <Card title="解锁方式">
        <div className="weq-applock-methods" role="radiogroup" aria-label="解锁方式">
          <button
            type="button"
            role="radio"
            aria-checked={method === 'totp'}
            className={`weq-applock-method${method === 'totp' ? ' is-active' : ''}`}
            onClick={() => void onSetMethod('totp')}
            disabled={settings.isLoading || setMethod.isLoading}
          >
            <span className="weq-applock-method-icon">
              <Smartphone size={18} strokeWidth={1.8} aria-hidden />
            </span>
            <span className="weq-applock-method-main">
              <strong>WeQ 验证器</strong>
              <small>RFC 6238 动态验证码 · 默认方式，无需系统能力</small>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={method === 'system'}
            className={`weq-applock-method${method === 'system' ? ' is-active' : ''}`}
            onClick={() => void onSetMethod('system')}
            disabled={settings.isLoading || setMethod.isLoading || !systemAvailable}
            title={
              systemAvailable
                ? undefined
                : (systemAuthQuery.data?.error ?? '当前设备系统认证不可用')
            }
          >
            <span className="weq-applock-method-icon">
              <Fingerprint size={18} strokeWidth={1.8} aria-hidden />
            </span>
            <span className="weq-applock-method-main">
              <strong>Windows Hello / Touch ID</strong>
              <small>
                {systemAvailable
                  ? '使用系统生物认证解锁'
                  : (systemAuthQuery.data?.error ?? '当前设备不支持系统认证')}
              </small>
            </span>
          </button>
        </div>
      </Card>

      {method === 'totp' ? (
        <Card
          title="WeQ 验证器"
          action={
            totpConfigured ? (
              <span className="weq-applock-bound-badge">
                <Check size={12} strokeWidth={2.4} aria-hidden />
                已绑定
              </span>
            ) : undefined
          }
        >
          {totpConfigured ? (
            <div className="weq-applock-bound">
              <Row
                label="绑定状态"
                desc="解锁时输入验证器 App 中的 6 位动态验证码即可。"
                control={
                  <span className="weq-applock-bound-ok">
                    <Check size={13} strokeWidth={2.2} aria-hidden />
                    已绑定
                  </span>
                }
              />
              <div className="weq-set-btn-group">
                <button type="button" className="weq-set-btn" onClick={() => void onRebind()}>
                  <RefreshCw size={13} aria-hidden />
                  重新绑定
                </button>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  onClick={() => void onUnbind()}
                >
                  <Unlink size={13} aria-hidden />
                  解除绑定
                </button>
              </div>
            </div>
          ) : (
            <div className="weq-applock-setup-empty">
              <p className="weq-set-desc">
                绑定后即可在验证器 App（Google Authenticator / Microsoft Authenticator / 1Password
                等）中生成动态验证码用于解锁。
              </p>
              <button type="button" className="weq-set-btn" onClick={() => setBindOpen(true)}>
                <KeyRound size={13} aria-hidden />
                开始绑定
              </button>
            </div>
          )}
        </Card>
      ) : null}

      {bindOpen ? (
        <TotpBindDialog
          onClose={() => setBindOpen(false)}
          onBound={() => {
            void queryClient.invalidateQueries({ queryKey: TOTP_STATUS_QUERY_KEY });
            pushToast({
              tone: 'success',
              title: '绑定成功',
              message: 'WeQ 验证器已生效，解锁时输入 6 位动态验证码即可。',
            });
          }}
        />
      ) : null}

      <Card title="空闲自动锁定">
        <Row
          label="无操作自动上锁"
          desc={
            canAutoLock
              ? '超过所选时长无操作后自动锁定，解锁需用当前解锁方式验证。'
              : autoLockBlockReason || '满足解锁条件后可开启自动锁定。'
          }
          control={
            <div className="weq-set-seg" role="radiogroup" aria-label="空闲自动锁定时长">
              {AUTO_LOCK_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={autoLockMinutes === opt.value}
                  className={`weq-set-seg-item${autoLockMinutes === opt.value ? ' is-on' : ''}`}
                  disabled={
                    settings.isLoading || setAutoLock.isLoading || (opt.value > 0 && !canAutoLock)
                  }
                  onClick={() => void onSetAutoLock(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          }
        />
      </Card>
    </div>
  );
}
