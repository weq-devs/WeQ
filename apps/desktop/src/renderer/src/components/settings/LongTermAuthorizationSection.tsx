import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck, Trash2, Wrench } from 'lucide-react';
import type { LongTermAuthorizationStatus } from '../../../../shared/long_term_authorization';
import { useTabActive } from '../RetainedTabs';
import { useDialog } from '../Dialog';
import { Card, Row } from './controls';
import { IS_WEB } from '../../lib/target';

const STATE_LABELS = {
  unavailable: '当前环境不可用',
  'not-installed': '未启用',
  ready: '已连接',
  'needs-repair': '需要修复',
} as const;

export function LongTermAuthorizationSection() {
  const active = useTabActive();
  const [status, setStatus] = useState<LongTermAuthorizationStatus | null>(null);
  const [pending, setPending] = useState<'status' | 'install' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const operation = useRef(false);
  const mounted = useRef(true);
  const confirm = useDialog((state) => state.confirm);
  const bridge = !IS_WEB ? window.weq?.authorization : undefined;
  const development = status?.development === true;

  const run = useCallback(
    async (kind: 'status' | 'install' | 'remove') => {
      if (!bridge || operation.current) return;
      operation.current = true;
      setPending(kind);
      setError('');
      try {
        if (kind !== 'status') {
          const approved = await confirm(
            `${kind === 'install' ? '启用或修复长期授权' : '撤销长期授权'}${development ? '（开发）' : ''}`,
            (development ? '仅管理独立开发通道，不替换或撤销正式助手。' : '') +
              (kind === 'install'
                ? '将请求系统管理员批准，安装全机共享的原生权限助手，授权当前系统用户的 QQ 内存读取和网卡抓包。不复制 Electron、Node 或聊天数据，不保存管理员密码，不修改 SIP 或全局 ptrace 保护。'
                : '将撤销当前系统用户的长期授权，正在使用权限助手的操作会中断，之后可继续临时授权。最后一位用户撤销时移除此通道的共享组件。'),
            { okLabel: kind === 'install' ? '继续授权' : '撤销授权' },
          );
          if (!approved || !mounted.current) return;
        }
        const result = kind === 'status' ? await bridge.status() : await bridge[kind](development);
        if (mounted.current) setStatus(result);
      } catch (failure) {
        if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
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
  return (
    <Card title={development ? '长期授权（开发）' : '长期授权'} settingId="long-term-authorization">
      <Row
        label="本机权限助手"
        desc={
          IS_WEB
            ? '请在运行 QQ 的电脑上打开 WeQ 桌面端管理长期授权。'
            : !bridge
              ? '当前宿主未提供权限助手管理接口。'
              : (status?.message ?? '正在检查本机权限助手…')
        }
        control={
          <span role="status" className="text-sm text-muted-foreground">
            {status ? STATE_LABELS[status.state] : bridge ? '检查中' : '不可用'}
          </span>
        }
      />
      {error && (
        <p className="weq-set-note" role="alert">
          {error}
        </p>
      )}
      {bridge && (
        <div className="weq-set-btn-group">
          <button
            type="button"
            className="weq-set-btn"
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
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            disabled={Boolean(pending)}
            onClick={() => void run('status')}
          >
            <RefreshCw size={14} />
            {pending === 'status' ? '检查中…' : '重新检查'}
          </button>
          {(status?.state === 'ready' || status?.state === 'needs-repair') && (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft weq-set-btn-del"
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
