import { Smartphone, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { notificationInlineText } from '../../../shared/notification_copy';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { IS_WEB } from '../lib/target.shared';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { useDialog } from './Dialog.shared';
import { NumericText } from './NumericText';
import { useRemotePairingReview } from './RemoteRequests.shared';
import { useToastApi } from './Toast.shared';
import type { RemoteStatus } from './settings/RemotePanel';
import '../styles/remote.css';

type PairingRequest = RemoteStatus['pending'][number];

export function RemoteRequests() {
  return IS_WEB ? null : <DesktopRemoteRequests />;
}

function DesktopRemoteRequests() {
  const notificationToast = useToastApi();
  const { data, refetch } = trpc.remote.status.useQuery(undefined, {
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
    retry: false,
  });
  const current = useDialog((state) => state.current);
  const reviewId = useRemotePairingReview((state) => state.id);
  const pending = data?.pending;
  const request = pending?.find(({ id }) => id === reviewId) ?? pending?.[0];
  const requestId = request?.id;
  const requestName = request?.name;
  useEffect(() => {
    if (!requestId || requestName === undefined) return;
    const key = `remote-request:${requestId}`;
    notificationToast.push({
      event: 'request',
      key,
      title: `${notificationInlineText(requestName, 28) || '有一部手机'}请求连接 WeQ`,
      summary: '等待你确认是否允许连接',
      source: notificationSource(
        { kind: 'app', target: { kind: 'setting', section: 'remote' } },
        '查看连接请求',
        null,
      ),
    });
    return () => {
      notificationToast.resolve(key);
    };
  }, [requestId, requestName, notificationToast]);
  return request ? (
    <RemotePairingDialog key={request.id} request={request} open={!current} refresh={refetch} />
  ) : null;
}

function RemotePairingDialog({
  request,
  open,
  refresh,
}: {
  request: PairingRequest;
  open: boolean;
  refresh: () => Promise<unknown>;
}) {
  const titleId = useId();
  const needsAccounts = request.scope === 'web:access';
  const accounts = trpc.remote.pairingAccounts.useQuery(undefined, {
    enabled: open && needsAccounts,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: false,
  });
  const decide = trpc.remote.decide.useMutation();
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountData = accounts.isFetchedAfterMount && !accounts.isError ? accounts.data : null;
  const currentConfigId = accountData?.currentConfigId;
  const configIds =
    accountData?.accounts
      .filter(({ configId }) => (picked ? picked.includes(configId) : configId === currentConfigId))
      .map(({ configId }) => configId) ?? [];
  const canApprove = !busy && (!needsAccounts || configIds.length > 0);

  async function submit(approve: boolean) {
    if (busy || (approve && !canApprove)) return;
    setBusy(true);
    setError(null);
    try {
      await decide.mutateAsync({
        id: request.id,
        approve,
        ...(approve && needsAccounts ? { configIds } : {}),
      });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '未能处理手机连接请求，请重试。');
      if (needsAccounts) void accounts.refetch();
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      centered
      focusContainerOnOpen
      dismissOnOutside={false}
      onClose={busy ? undefined : () => void submit(false)}
      labelledBy={titleId}
      width={368}
      className="weq-message-modal"
    >
      <div className="weq-dialog weq-dialog-info">
        <div className="weq-dialog-head">
          <span className="weq-dialog-icon">
            <Smartphone size={20} aria-hidden />
          </span>
          <h3 id={titleId} className="weq-dialog-title">
            手机请求连接 WeQ
          </h3>
          <button
            type="button"
            className="weq-dialog-x"
            aria-label="关闭"
            disabled={busy}
            onClick={() => void submit(false)}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="weq-dialog-body">
          <p>
            {request.name} · 校验码 <NumericText>{request.code}</NumericText>
          </p>
          {needsAccounts ? (
            <fieldset className="weq-remote-pairing-accounts" disabled={busy}>
              <legend>允许此手机访问的账号</legend>
              {accounts.isError ? (
                <div role="alert">
                  读取账号列表失败。
                  <button
                    type="button"
                    className="weq-set-btn"
                    onClick={() => void accounts.refetch()}
                  >
                    重试
                  </button>
                </div>
              ) : !accountData ? (
                <p role="status">正在读取账号…</p>
              ) : accountData.accounts.length === 0 ? (
                <p>请先在电脑上的 WeQ 添加账号，再为手机授权。</p>
              ) : (
                accountData.accounts.map(({ configId, displayName, uin, static: isStatic }) => {
                  const checked = configIds.includes(configId);
                  return (
                    <label className="weq-remote-pairing-account" key={configId}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setPicked(
                            event.currentTarget.checked
                              ? [...configIds, configId]
                              : configIds.filter((id) => id !== configId),
                          )
                        }
                      />
                      <span className="weq-remote-account-label">
                        <span className="weq-remote-account-name" title={displayName}>
                          {displayName}
                        </span>
                        <span className="weq-remote-account-number">
                          <NumericText>{uin}</NumericText>
                          {isStatic ? ' · 静态备份' : null}
                          {configId === currentConfigId ? ' · 当前账号' : null}
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </fieldset>
          ) : (
            <p>允许后，手机可以查看电脑的在线状态。</p>
          )}
          {error && (
            <p className="weq-remote-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="weq-dialog-foot">
          <button
            type="button"
            className="weq-action-soft"
            disabled={busy}
            onClick={() => void submit(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="weq-action-primary"
            data-weq-dialog-confirm
            disabled={!canApprove}
            onClick={() => void submit(true)}
          >
            允许连接
          </button>
        </div>
      </div>
    </Modal>
  );
}
