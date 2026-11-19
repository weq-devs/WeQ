import { useEffect, useRef, useState, type ComponentType } from 'react';
import { trpc } from '../../trpc/client';
import { pickAccountFile } from '../../lib/accountFilePicker';
import { useTabActive } from '../RetainedTabs.shared';
import {
  useQQWriteSession,
  type QQWriteBinding,
  type QQWriteOutcome,
  type QQWriteFeedback,
} from '../../hooks/useQQWriteSession';
import { useViewState } from '../../state/view';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useDialog } from '../Dialog.shared';
import type { DangerLevel } from '../Dialog';
import '../../styles/qq-actions.css';
import { useRenderDocument } from '../../lib/renderDocument';
import {
  NotificationSourceProvider,
  type NotificationTarget,
} from '../../lib/notificationNavigation';
import { notificationSource } from '../../lib/notificationNavigation.shared';

/** 同号切换数据源也销毁草稿，不能仅以 QQ 号判断编辑器身份。 */
export function withQQAccountScope<P extends object>(
  Component: ComponentType<P>,
  sourceFor?: (props: P) => NotificationTarget,
) {
  return function QQAccountScopedAction(props: P) {
    const active = useTabActive();
    const uin = useViewState((s) => s.openedUin);
    const config = trpc.account.getAccountConfig.useQuery(undefined, {
      enabled: active && Boolean(uin),
      refetchOnMount: false,
    });
    const id = config.data?.uin === uin ? config.data.configId : '';
    const body = <Component key={`${uin}:${id}`} {...props} />;
    return sourceFor ? (
      <NotificationSourceProvider source={notificationSource(sourceFor(props))}>
        {body}
      </NotificationSourceProvider>
    ) : (
      body
    );
  };
}
export function useQQAction(scope: string, feedback: QQWriteFeedback = 'all') {
  const ownerDocument = useRenderDocument();
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
    options?: Parameters<typeof session.run>[2] & { danger?: DangerLevel },
  ) {
    if (busy.current || disabled) return false;
    busy.current = true;
    setPending(true);
    try {
      const { danger, ...writeOptions } = options ?? {};
      if (warning && !(await confirm('确认 QQ 操作', warning, { ownerDocument, danger })))
        return false;
      if (!mounted.current || latest.current !== identity) return false;
      return await session.run(action, refresh, { feedback, ...writeOptions });
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function pick(
    kind: 'image' | 'file',
    onProgress?: (received: number, total: number) => void,
  ): Promise<{ path: string; fileName: string } | null> {
    setError('');
    if (busy.current || disabled) return null;
    busy.current = true;
    setPending(true);
    try {
      const result = await pickAccountFile(
        kind,
        session.binding ?? undefined,
        undefined,
        onProgress,
      );
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
    pickFile: (onProgress?: (received: number, total: number) => void) => pick('file', onProgress),
    error,
  };
}
export function useQQGroupPermissions(
  groupId: number,
  action: Pick<ReturnType<typeof useQQAction>, 'available' | 'binding'>,
) {
  const autoRefresh = useQQAutoRefresh(
    action.available && Number.isSafeInteger(groupId) && groupId > 0,
  );
  return trpc.account.qqActions.groupPermissions.useQuery(
    { ...action.binding!, groupId },
    {
      ...autoRefresh,
      staleTime: 15_000,
    },
  );
}

export function useQQAlbumPermissions(
  groupId: number,
  albumId: string | undefined,
  action: Pick<ReturnType<typeof useQQAction>, 'available' | 'binding'>,
) {
  return trpc.account.qqActions.albumPermissions.useQuery(
    { ...action.binding!, groupId, albumId },
    { enabled: action.available && groupId > 0, staleTime: 15_000, retry: false },
  );
}
