import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { RemoteAccountChoice } from '../../../shared/remote_account_switch';
import { accountGatewayConfigId, accountGatewayPath } from '../lib/accountGateway';
import { confirmMailAccountLeave } from '../state/mailDraft';
import { Modal } from './Dialog';
import { AvatarPicture } from './AvatarPicture';
import { RemoteShellMenuButton } from './RemoteShellMenus';
import '../styles/remote-account-switch.css';

const jsonHeaders = { Accept: 'application/json' };

export function RemoteAccountSwitcher({
  listPath,
  onClose,
}: {
  listPath: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const attempt = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = useQuery({
    queryKey: ['remote-account-choices', listPath],
    queryFn: async ({ signal }): Promise<RemoteAccountChoice[]> => {
      const response = await fetch(listPath, { headers: jsonHeaders, signal, redirect: 'error' });
      if (!response.ok) throw new Error('无法读取账号列表。');
      return response.json();
    },
    retry: false,
  });
  useEffect(() => () => attempt.current?.abort(), []);

  function close() {
    attempt.current?.abort();
    onClose();
  }

  async function select(configId: string) {
    if (attempt.current) return;
    if (configId === accountGatewayConfigId) return close();
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setError('');
    let navigating = false;
    try {
      if (!(await confirmMailAccountLeave()) || controller.signal.aborted) return;
      const response = await fetch(accountGatewayPath('/_weq/select-account'), {
        method: 'POST',
        headers: jsonHeaders,
        body: new URLSearchParams({ configId }),
        signal: controller.signal,
        redirect: 'error',
      });
      const result = (await response.json()) as { location?: string; error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok || !result.location?.startsWith('/_weq/account/')) {
        setError(result.error || '账号打开失败，请重试。');
        return;
      }
      location.assign(result.location);
      navigating = true;
    } catch {
      if (!controller.signal.aborted) setError('账号打开失败，请重试。');
    } finally {
      if (!controller.signal.aborted && !navigating) {
        attempt.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <Modal
      labelledBy={titleId}
      onClose={close}
      dismissOnOutside={false}
      focusContainerOnOpen
      layerClassName="weq-remote-account-layer"
      className="weq-remote-account-picker"
    >
      <div className="weq-remote-account-tools weq-web-shell">
        <RemoteShellMenuButton />
      </div>
      <div className="weq-remote-account-content">
        <header>
          <h1 id={titleId}>切换账号</h1>
          <button
            type="button"
            className="weq-remote-account-close"
            aria-label="取消切换"
            title="取消切换"
            onClick={close}
          >
            <X size={24} aria-hidden />
          </button>
        </header>
        {error && <p role="alert">{error}</p>}
        {choices.isLoading ? (
          <p role="status">正在读取账号…</p>
        ) : choices.isError ? (
          <>
            <p role="alert">无法读取账号列表。</p>
            <button
              type="button"
              className="weq-set-btn"
              disabled={choices.isFetching}
              onClick={() => void choices.refetch()}
            >
              重试
            </button>
          </>
        ) : !choices.data.length ? (
          <p>暂无可访问的账号。请在电脑上的 WeQ 检查账号及授权。</p>
        ) : (
          choices.data.map((account) => (
            <button
              key={account.configId}
              type="button"
              className="weq-remote-account-choice"
              aria-current={account.configId === accountGatewayConfigId ? true : undefined}
              disabled={busy}
              onClick={() => void select(account.configId)}
            >
              <AvatarPicture className="weq-remote-account-avatar" src={account.avatarUrl} />
              <span className="weq-remote-account-name">
                <strong>{account.displayName}</strong>
                <small>
                  {account.uin}
                  {account.static ? ' · 静态备份' : ''}
                </small>
              </span>
              <small
                className="weq-remote-account-status"
                data-online={account.online === true || undefined}
              >
                {account.online === null ? '状态未知' : account.online ? 'WeQ 在线' : 'WeQ 离线'}
              </small>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
