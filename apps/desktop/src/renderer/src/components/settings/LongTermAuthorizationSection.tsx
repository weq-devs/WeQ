import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck, Trash2, Wrench } from 'lucide-react';
import type { LongTermAuthorizationStatus } from '../../../../shared/long_term_authorization';
import { useTabActive } from '../RetainedTabs.shared';
import { useDialog } from '../Dialog.shared';
import { Card, SettingsStatusBadge } from './controls';
import { authorizationFailure, type AuthorizationFailure } from '../../lib/authorizationError';
import { IS_WEB } from '../../lib/target.shared';

const STATE_LABELS = {
  unavailable: '当前环境不可用',
  'not-installed': '未授权',
  ready: '已授权',
  'needs-repair': '需要修复',
} as const;

type Operation = 'status' | 'install' | 'remove';

export function LongTermAuthorizationSection() {
  const active = useTabActive();
  const [status, setStatus] = useState<LongTermAuthorizationStatus | null>(null);
  const [pending, setPending] = useState<Operation | null>(null);
  const [error, setError] = useState<(AuthorizationFailure & { operation: Operation }) | null>(
    null,
  );
  const operation = useRef(false);
  const mounted = useRef(true);
  const confirm = useDialog((state) => state.confirm);
  const bridge = !IS_WEB ? window.weq?.authorization : undefined;
  const development = status?.development === true;

  const run = useCallback(
    async (kind: Operation) => {
      if (!bridge || operation.current) return;
      operation.current = true;
      setPending(kind);
      if (kind !== 'status') setError(null);
      try {
        if (kind !== 'status') {
          const approved = await confirm(
            `${kind === 'install' ? '启用或修复长期授权' : '撤销长期授权'}${development ? '（开发）' : ''}`,
            (development ? '仅管理独立开发通道，不替换或撤销正式助手。' : '') +
              (kind === 'install'
                ? '将请求系统管理员批准，安装全机共享的原生权限助手，授权当前系统用户的 QQ 内存读取和网卡抓包。不复制 Electron、Node 或聊天数据，不保存管理员密码，不修改 SIP 或全局 ptrace 保护。'
                : '将撤销当前系统用户的长期授权，正在使用权限助手的操作会中断，之后可继续临时授权。最后一位用户撤销时移除此通道的共享组件。'),
            {
              danger: kind === 'remove' ? 'outline' : undefined,
              okLabel: kind === 'install' ? '继续授权' : '撤销授权',
            },
          );
          if (!approved || !mounted.current) return;
        }
        const result = kind === 'status' ? await bridge.status() : await bridge[kind](development);
        if (mounted.current) {
          setStatus(result);
          setError(null);
        }
      } catch (failure) {
        // 失败原文是助手的英文 bail!，渲染层统一翻成用户能照着做的说明。
        if (mounted.current)
          setError({
            ...authorizationFailure(failure instanceof Error ? failure.message : String(failure), {
              development,
              operation: kind,
            }),
            operation: kind,
          });
      } finally {
        operation.current = false;
        if (mounted.current) setPending(null);
      }
    },
    [bridge, confirm, development],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active || !bridge) return;
    void run('status');
    const focus = () => void run('status');
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
    // 控制面身份在本机窗口生命周期内不变，离开页面不自动安装或撤销。
  }, [active, bridge, run]);

  const canManage = Boolean(bridge && status && status.state !== 'unavailable');
  const canRecheck =
    status?.state === 'needs-repair' ||
    error?.operation === 'status' ||
    error?.needsUserAction ||
    error?.retryStatus;
  const checkFailed = error?.operation === 'status';
  const label = checkFailed
    ? '状态待确认'
    : status
      ? STATE_LABELS[status.state]
      : bridge
        ? '检查中'
        : '不可用';
  const tone =
    checkFailed || status?.state === 'needs-repair'
      ? 'warning'
      : status?.state === 'ready'
        ? 'ready'
        : 'neutral';
  const guidance = IS_WEB
    ? '请在运行 QQ 的电脑上打开 WeQ 桌面端管理长期授权。'
    : !bridge
      ? '当前桌面端未提供权限助手管理功能。'
      : status?.state !== 'ready' || development
        ? status?.message
        : undefined;
  return (
    <Card
      title={development ? '长期授权（开发）' : '长期授权'}
      titleBadge={<SettingsStatusBadge label={label} tone={tone} />}
      desc="减少当前系统用户读取 QQ 内存和网卡抓包时的重复管理员授权。"
      icon={<ShieldCheck size={15} strokeWidth={1.8} />}
      settingId="long-term-authorization"
    >
      {status?.reason === 'interface-changed' && !checkFailed ? (
        <p className="weq-set-note weq-set-note-multiline weq-set-note-warn" role="alert">
          <AlertTriangle size={12} strokeWidth={1.9} aria-hidden />
          <span>权限助手的接口已更新。请点击「修复授权」重新启用。</span>
        </p>
      ) : guidance && !checkFailed ? (
        <p className="weq-set-note">{guidance}</p>
      ) : null}
      {error && (
        <p
          className={`weq-set-note weq-set-note-multiline${
            error.needsUserAction ? ' weq-set-note-warn' : ''
          }`}
          role="alert"
        >
          {error.needsUserAction && <AlertTriangle size={12} strokeWidth={1.9} aria-hidden />}
          <span>{error.message}</span>
        </p>
      )}
      {bridge && (
        <div className="weq-set-btn-group">
          <button
            type="button"
            className={`weq-set-btn${status?.state === 'ready' ? '' : ' weq-set-btn-primary'}`}
            disabled={Boolean(pending) || !canManage}
            onClick={() => void run('install')}
          >
            {status?.state === 'needs-repair' || status?.state === 'ready' ? (
              <Wrench size={14} />
            ) : (
              <ShieldCheck size={14} />
            )}
            {pending === 'install'
              ? '正在授权…'
              : status?.state === 'needs-repair' || status?.state === 'ready'
                ? '修复授权'
                : '启用长期授权'}
          </button>
          {canRecheck && (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft"
              disabled={Boolean(pending)}
              onClick={() => void run('status')}
            >
              <RefreshCw size={14} />
              {pending === 'status' ? '检查中…' : '重新检查'}
            </button>
          )}
          {(status?.state === 'ready' || status?.state === 'needs-repair') && (
            <button
              type="button"
              className="weq-set-btn"
              data-danger="outline"
              disabled={Boolean(pending)}
              onClick={() => void run('remove')}
            >
              <Trash2 size={14} />
              {pending === 'remove' ? '正在撤销…' : '撤销授权'}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
