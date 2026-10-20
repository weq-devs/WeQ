import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ImagePlus, RefreshCw, Save } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import {
  useQQWriteSession,
  type QQWriteBinding,
  type QQWriteOutcome,
} from '../../hooks/useQQWriteSession';
import { useViewState } from '../../state/view';
import { QQWriteResult } from '../QQWriteControls';
import { useDialog } from '../Dialog';
import '../../styles/qq-actions.css';

/** 同号切换数据源也销毁草稿，不能仅以 QQ 号判断编辑器身份。 */
export function withQQAccountScope<P extends object>(Component: ComponentType<P>) {
  return function QQAccountScopedAction(props: P) {
    const uin = useViewState((s) => s.openedUin);
    const config = trpc.account.getAccountConfig.useQuery(undefined, {
      enabled: Boolean(uin),
      refetchOnMount: false,
    });
    const id = config.data?.uin === uin ? config.data.configId : '';
    return <Component key={`${uin}:${id}`} {...props} />;
  };
}

export function ActionIcon({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="weq-set-iconbtn"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function useQQAction(scope: string) {
  const session = useQQWriteSession(`actions:${scope}`);
  const confirm = useDialog((s) => s.confirm);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const busy = useRef(false),
    mounted = useRef(true);
  const identity = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${scope}`;
  const latest = useRef(identity);
  latest.current = identity;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const disabled = !session.available || session.busy || pending;
  async function perform(
    action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
    refresh?: () => Promise<unknown>,
    warning?: string,
  ) {
    if (busy.current || disabled) return false;
    busy.current = true;
    setPending(true);
    try {
      if (warning && !(await confirm('确认 QQ 操作', warning))) return false;
      if (!mounted.current || latest.current !== identity) return false;
      return await session.run(action, refresh);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function pick(kind: 'image' | 'file'): Promise<{ path: string; fileName: string } | null> {
    setError('');
    if (busy.current || disabled) return null;
    busy.current = true;
    setPending(true);
    try {
      const result = await client.account.pickSendFile.mutate({ kind });
      return mounted.current && latest.current === identity ? result : null;
    } catch (e) {
      if (mounted.current && latest.current === identity)
        setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return {
    ...session,
    disabled,
    pending,
    perform,
    pickImage: () => pick('image'),
    pickFile: () => pick('file'),
    error,
  };
}
export function ActionFeedback({ action }: { action: ReturnType<typeof useQQAction> }) {
  return (
    <>
      <QQWriteResult result={action.result} />
      {action.error && <p role="alert">{action.error}</p>}
    </>
  );
}
export function useQQGroupPermissions(
  groupId: number,
  action: Pick<ReturnType<typeof useQQAction>, 'available' | 'binding'>,
) {
  return trpc.account.qqActions.groupPermissions.useQuery(
    { ...action.binding!, groupId },
    {
      enabled: action.available && Number.isSafeInteger(groupId) && groupId > 0,
      staleTime: 15_000,
      retry: false,
    },
  );
}
export function SaveAction({
  disabled,
  onClick,
  label = '保存',
}: {
  disabled?: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <ActionIcon label={label} disabled={disabled} onClick={onClick}>
      <Save size={16} />
    </ActionIcon>
  );
}
export function RefreshAction({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <ActionIcon label="刷新" disabled={disabled} onClick={onClick}>
      <RefreshCw size={16} />
    </ActionIcon>
  );
}
export function ImageAction({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <ActionIcon label="选择图片" disabled={disabled} onClick={onClick}>
      <ImagePlus size={16} />
    </ActionIcon>
  );
}
