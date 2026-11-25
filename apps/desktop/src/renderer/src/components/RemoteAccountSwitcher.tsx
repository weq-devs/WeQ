import { NumericText } from './NumericText';
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
  REMOTE_ACCOUNT_ACCESS,
  type RemoteAccountAccessResult,
  type RemoteAccountChoice,
} from '../../../shared/remote_account_switch';
import { accountGatewayConfigId, accountGatewayPath } from '../lib/accountGateway';
import { confirmMailAccountLeave } from '../state/mailDraft';
import { Modal } from './Dialog';
import { useDialog } from './Dialog.shared';
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
  const [feedback, setFeedback] = useState('');
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

  async function select(account: RemoteAccountChoice) {
    const { configId } = account;
    const needsAccess = account.authorized === false;
    if (attempt.current) return;
    if (!needsAccess && configId === accountGatewayConfigId) return close();
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setError('');
    setFeedback('');
    let navigating = false;
    try {
      if (needsAccess) {
        const confirmed = await useDialog
          .getState()
          .confirm(
            '申请账号访问权限',
            `要向电脑申请访问 ${account.displayName}（${account.uin}${account.static ? ' · 静态备份' : ''}）吗？`,
            { tone: 'info', okLabel: '发送申请' },
          );
        if (!confirmed || controller.signal.aborted) return;
        setFeedback('正在发送申请…');
        const requestOptions = {
          headers: jsonHeaders,
          signal: controller.signal,
          redirect: 'error' as const,
        };
        const response = await fetch(REMOTE_ACCOUNT_ACCESS, {
          ...requestOptions,
          method: 'POST',
          body: new URLSearchParams({ configId }),
        });
        let result = (await response.json()) as RemoteAccountAccessResult & { error?: string };
        if (!response.ok) {
          setFeedback('');
          setError(result.error || '未能发送申请，请重试。');
          return;
        }
        if (result.state === 'pending') setFeedback('已发送申请，请在电脑上的 WeQ 确认。');
        while (result.state === 'pending') {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (controller.signal.aborted) return;
          const poll = await fetch(
            `${REMOTE_ACCOUNT_ACCESS}?${new URLSearchParams({ id: result.id })}`,
            requestOptions,
          );
          if (!poll.ok) throw new Error();
          result = await poll.json();
        }
        if (controller.signal.aborted) return;
        if (result.state === 'approved') {
          setFeedback('电脑已授权，可选择该账号。');
          await choices.refetch();
        } else if (result.state === 'denied') {
          setFeedback('电脑拒绝了访问申请。');
        } else {
          setFeedback('访问申请已失效，可重新申请。');
        }
        return;
      }
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
      if (!controller.signal.aborted) {
        setFeedback('');
        setError(needsAccess ? '未能确认申请状态，请重试。' : '账号打开失败，请重试。');
      }
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
        {feedback && <p role="status">{feedback}</p>}
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
          <p>电脑上的 WeQ 暂无账号。</p>
        ) : (
          choices.data.map((account) => (
            <button
              key={account.configId}
              type="button"
              className="weq-remote-account-choice"
              aria-current={account.configId === accountGatewayConfigId ? true : undefined}
              disabled={busy}
              onClick={() => void select(account)}
            >
              <AvatarPicture className="weq-remote-account-avatar" src={account.avatarUrl} />
              <span className="weq-remote-account-name">
                <strong>{account.displayName}</strong>
                <small>
                  <NumericText>{account.uin}</NumericText>
                  {account.static ? ' · 静态备份' : ''}
                </small>
              </span>
              <small
                className="weq-remote-account-status"
                data-online={account.online === true || undefined}
              >
                {account.authorized === false
                  ? '未授权'
                  : account.online === null
                    ? '状态未知'
                    : account.online
                      ? 'WeQ 在线'
                      : 'WeQ 离线'}
              </small>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
