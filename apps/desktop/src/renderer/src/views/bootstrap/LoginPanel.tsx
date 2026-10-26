/**
 * 账号打开与密钥子功能，维护当前账号的密钥生命周期：
 *
 *   获取密钥 (new mode) — pure protocol, identical on all three platforms:
 *       has a1  → quick login   (unusual device ⇒ the user taps 确认 on the phone)
 *       no a1   → QR login      (scanned / confirmed on the phone)
 *       quick login fails → fall back to QR
 *   进入 — ALWAYS tests the key first (testDatabaseKey); a wrong key shows an
 *       error dialog and refuses entry. On success opens the account and,
 *       when ticked, records the global "auto-enter" target.
 *
 * There is no privilege escalation anywhere: login talks to the login server
 * directly (nt_helper.quickLogin / qrLogin), so no QQ process is launched and
 * no admin password is ever requested.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowRight, KeyRound, Loader2, QrCode, Settings2, X } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { Modal, useDialog } from '../../components/Dialog';
import type { AutoEnterTarget } from '@weq/service';
import { accountSource } from './AccountSelector';
import { QqAvatar } from '../../components/QqAvatar';
import { KeyField, isCompleteKey } from './KeyField';
import { QrDialog } from './QrDialog';
import type { UiAccount } from './types';

type Sub = { unsubscribe: () => void };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sameTarget(target: AutoEnterTarget | null, acc: UiAccount | null): boolean {
  if (!target || !acc) return false;
  if (target.configId && acc.configId) return target.configId === acc.configId;
  return target.uin === acc.uin && (target.dataDir ?? '') === (acc.dataDir ?? '');
}

export function LoginPanel({
  mode,
  accounts,
  selected,
  onSelect,
  autoTarget,
  onEntered,
  onBusyChange,
  onDiagnostics,
  disabled = false,
}: {
  mode: 'new' | 'existing';
  accounts: UiAccount[];
  selected: UiAccount | null;
  onSelect: (acc: UiAccount) => void;
  autoTarget: AutoEnterTarget | null;
  onEntered: (uin: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDiagnostics?: () => void;
  disabled?: boolean;
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const settings = trpc.bootstrap.getSettings.useQuery();
  const utils = trpc.useUtils();
  const autoAttach = trpc.bootstrap.setAutoAttachQq.useMutation({
    onSuccess: () => utils.bootstrap.getSettings.invalidate(),
    onError: (e) => showError('设置失败', e.message),
  });

  const [key, setKey] = useState('');
  /**
   * p_skey the login flow harvested alongside the dbkey. Handed to
   * `openAccount` so the home-dress fetch has a ticket even though no QQ
   * process is alive. Cleared whenever the selected account changes.
   */
  const pskeyRef = useRef<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [autoChoice, setAutoChoice] = useState<{ key: string; value: boolean } | null>(null);
  const choiceKey = `${mode}:${selected?.key ?? ''}`;
  const autoEnter =
    autoChoice?.key === choiceKey ? autoChoice.value : sameTarget(autoTarget, selected);
  const working = busy || disabled || autoAttach.isLoading;
  const [error, setError] = useState('');
  const [keyDetails, setKeyDetails] = useState(false);
  const autoOpening = useRef(false);
  const pendingKey = useRef<{
    accountKey: string;
    key: string;
    pskey: Record<string, string> | null;
  } | null>(null);
  const alive = useRef(true);
  const request = useRef(0);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  // QR dialog state. `anonymous` = the "登录新的账号" flow, where the currently
  // selected account is irrelevant, so its identity must not be shown.
  const [qr, setQr] = useState<{
    uin: string;
    name: string;
    avatarUrl: string | null;
    status: string;
    url: string | null;
    anonymous: boolean;
  } | null>(null);
  const subRef = useRef<Sub | null>(null);

  // Reset the key + flags whenever the selected account changes.
  useEffect(() => {
    const pending = pendingKey.current?.accountKey === selected?.key ? pendingKey.current : null;
    setKey(pending?.key ?? (mode === 'existing' ? (selected?.dbKey ?? '') : ''));
    // The ticket belongs to the account that was just logged in — never carry
    // it over to a different one.
    pskeyRef.current = pending?.pskey ?? null;
    pendingKey.current = null;
    setStatus(pending ? '密钥已就绪' : '');
    setError('');
    setKeyDetails(false);
  }, [selected?.key, mode, selected?.dbKey]);

  // Tear down any live subscription on unmount.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current++;
      subRef.current?.unsubscribe();
    };
  }, []);

  function closeSub(): void {
    request.current++;
    subRef.current?.unsubscribe();
    subRef.current = null;
  }

  // ---- key acquisition (new mode) ----

  function acquire(automatic = false): void {
    if (!selected || (working && !automatic)) return;
    autoOpening.current = automatic;
    setError('');
    setKeyDetails(false);
    setBusy(true);
    // Pick the flow off the one thing that matters: does the account have a
    // cached a1? (No online check, no platform branch.)
    if (selected.a1Key) {
      startQuickLogin(selected);
    } else {
      startQrLogin(selected);
    }
  }

  function startQuickLogin(acc: UiAccount): void {
    setStatus('正在快速登录…');
    closeSub();
    const id = request.current;
    subRef.current = client.bootstrap.quickLogin.subscribe(
      { uin: acc.uin },
      {
        onData(event) {
          if (!alive.current || id !== request.current) return;
          if (event.kind === 'state') {
            // Progress, including the "confirm on your phone" prompt.
            setStatus(event.message || event.state);
          } else if (event.kind === 'result') {
            closeSub();
            if (event.result.success && event.result.dbkey) {
              if (event.result.pskey) pskeyRef.current = event.result.pskey;
              setKey(event.result.dbkey);
              setStatus('已获取密钥');
              setBusy(false);
              if (autoOpening.current) void enter(acc, event.result.dbkey, false);
            } else {
              // Quick login failed → fall back to QR.
              setStatus('快速登录失败，转二维码…');
              startQrLogin(acc);
            }
          }
        },
        onError() {
          if (!alive.current || id !== request.current) return;
          closeSub();
          setStatus('快速登录失败，转二维码…');
          startQrLogin(acc);
        },
      },
    );
  }

  function startQrLogin(acc: UiAccount | null, anonymous = false): void {
    setStatus('正在获取二维码…');
    setQr({
      uin: acc?.uin ?? '',
      name: acc?.name ?? '',
      avatarUrl: acc?.avatarUrl ?? null,
      status: '正在获取二维码…',
      url: null,
      anonymous,
    });
    closeSub();
    const id = request.current;
    let seenUin = anonymous ? '' : (acc?.uin ?? '');
    // 已知账号的扫码：把 uin 传给主进程，好让它定位该账号的 nt_msg.db 读
    // key_meta（否则 native 会因缺 key_meta 拿不到 dbkey）。「登录新的账号」是
    // 匿名扫码——当前选中的账号不是要登的那个，绝不能把它的 key_meta 带进去。
    const input = anonymous ? undefined : { uin: acc?.uin };
    subRef.current = client.bootstrap.qrLogin.subscribe(input, {
      onData(event) {
        if (!alive.current || id !== request.current) return;
        if (event.kind === 'state') {
          setQr((q) => (q ? { ...q, status: event.message || q.status } : q));
        } else if (event.kind === 'qrcode') {
          setQr((q) => (q ? { ...q, url: event.url, status: '请使用手机 QQ 扫码' } : q));
        } else if (event.kind === 'qrcode-state') {
          if (event.uin) seenUin = event.uin;
          setQr((q) => (q ? { ...q, status: formatQrState(event.state) } : q));
        } else if (event.kind === 'result') {
          closeSub();
          setQr(null);
          if (event.result.success && event.result.dbkey) {
            const match = anonymous ? accountsRef.current.find((a) => a.uin === seenUin) : acc;
            if (!match || match.uin !== seenUin) {
              setBusy(false);
              setStatus('');
              setError(
                '未发现扫码账号的本地记录。请先在本机 QQ 登录并同步记录，或导入该账号的备份。',
              );
              return;
            }
            if (match.key !== selected?.key) {
              pendingKey.current = {
                accountKey: match.key,
                key: event.result.dbkey,
                pskey: event.result.pskey ?? null,
              };
              onSelect(match);
            }
            pskeyRef.current = event.result.pskey ?? null;
            setKey(event.result.dbkey);
            setStatus('已获取密钥');
            setBusy(false);
            if (autoOpening.current) void enter(match, event.result.dbkey, false);
          } else {
            setBusy(false);
            setStatus('');
            const message = event.result.error ?? '扫码登录失败，请填入数据库密钥。';
            if (autoOpening.current) recoveryFailed(message);
            else showError('扫码登录失败', message);
          }
        }
      },
      onError(e) {
        if (!alive.current || id !== request.current) return;
        closeSub();
        setQr(null);
        setBusy(false);
        setStatus('');
        if (autoOpening.current) recoveryFailed(errMsg(e));
        else showError('扫码登录失败', errMsg(e));
      },
    });
  }

  /** 「登录新的账号」：直接走匿名扫码（登录本身不再需要任何安装步骤）。 */
  function startNewAccountQr(): void {
    if (working) return;
    setError('');
    setBusy(true);
    autoOpening.current = false;
    startQrLogin(selected, true);
  }

  function cancelQr(): void {
    closeSub();
    setQr(null);
    setBusy(false);
    setStatus('');
    if (autoOpening.current) recoveryFailed('自动获取已取消，请填入数据库密钥。');
  }

  function recoveryFailed(message: string): void {
    setError(message);
    setKeyDetails(true);
    autoOpening.current = false;
  }

  // ---- enter (test then open) ----

  async function enter(acc = selected, candidate = key, recover = true): Promise<void> {
    if (!acc) return;
    const selected = acc;
    setError('');

    // Static (offline) accounts have no live key gate — re-open them directly
    // from their saved decrypted-db directory + (optional) stored key.
    if (selected.static) {
      if (!selected.dataDir) {
        showError('无法打开', '该静态账号缺少数据库目录，请重新导入。');
        return;
      }
      setBusy(true);
      setStatus('正在打开本地数据库…');
      try {
        await client.bootstrap.openStaticAccount.mutate({
          dirPath: selected.dataDir,
          preview: {
            uin: selected.uin,
            displayName: selected.hasName ? selected.name : '',
            avatarUrl: selected.avatarUrl ?? '',
          },
          ...(selected.dbKey ? { dbKey: selected.dbKey } : {}),
          ...(selected.algos?.['nt_msg.db'] ? { algo: selected.algos['nt_msg.db'] } : {}),
          ...(selected.mobile ? { mobile: true } : {}),
        });
        if (!alive.current) return;
        if (autoEnter) {
          await client.bootstrap.setAutoEnter.mutate({
            uin: selected.uin,
            ...(selected.dataDir ? { dataDir: selected.dataDir } : {}),
          });
        } else if (sameTarget(autoTarget, selected)) {
          await client.bootstrap.clearAutoEnter.mutate();
        }
        onEntered(selected.uin);
      } catch (e) {
        if (!alive.current) return;
        setBusy(false);
        setStatus('');
        setError(errMsg(e));
      }
      return;
    }

    const k = candidate.trim();
    if (!isCompleteKey(k)) {
      if (recover) acquire(true);
      else recoveryFailed('获取的密钥不完整，请手动填入数据库密钥。');
      return;
    }
    setBusy(true);
    setStatus('正在验证密钥…');
    let keyValidated = false;
    try {
      const test = await client.bootstrap.testDatabaseKey.mutate({ uin: selected.uin, dbKey: k });
      if (!alive.current) return;
      if (!test.success) {
        setBusy(false);
        setStatus('');
        setError(test.error ?? '数据库密钥不正确，请重新获取密钥。');
        if (recover) acquire(true);
        else recoveryFailed(test.error ?? '获取的密钥无法打开数据库，请手动填入。');
        return;
      }
      keyValidated = true;
      await client.bootstrap.openAccount.mutate({
        uin: selected.uin,
        dbKey: k,
        algo: test.algo,
        ...(selected.hasName ? { displayName: selected.name } : {}),
        ...(selected.avatarUrl ? { avatarUrl: selected.avatarUrl } : {}),
        ...(selected.dataDir ? { dataDir: selected.dataDir } : {}),
        ...(pskeyRef.current ? { pskey: pskeyRef.current } : {}),
      });
      if (!alive.current) return;

      if (autoEnter) {
        await client.bootstrap.setAutoEnter.mutate({
          uin: selected.uin,
          ...(selected.dataDir ? { dataDir: selected.dataDir } : {}),
        });
      } else if (sameTarget(autoTarget, selected)) {
        await client.bootstrap.clearAutoEnter.mutate();
      }

      onEntered(selected.uin);
      setKeyDetails(false);
    } catch (e) {
      if (!alive.current) return;
      setBusy(false);
      setStatus('');
      setError(errMsg(e));
      if (!keyValidated) {
        if (recover) acquire(true);
        else recoveryFailed(errMsg(e));
      }
    }
  }

  function onAction(): void {
    if (!working) void enter();
  }

  return (
    <div className="weq-login-panel">
      {selected ? (
        <>
          <div className="weq-open-identity">
            <QqAvatar uin={selected.uin} url={selected.avatarUrl} size={64} />
            <div>
              <h2 title={selected.name}>{selected.name}</h2>
              <span>
                {selected.uin} · {accountSource(selected)}
              </span>
            </div>
            {mode === 'new' && onDiagnostics && (
              <button
                type="button"
                className="weq-icon-button weq-open-key-button"
                title="环境诊断"
                aria-label="环境诊断"
                onClick={onDiagnostics}
              >
                <Settings2 size={16} aria-hidden />
              </button>
            )}
          </div>
          <div className="weq-open-state">
            {selected.static ? '本地备份已保存' : key ? '密钥已就绪' : '尚未获取密钥'}
          </div>

          {status && (
            <div className="weq-login-status" role="status">
              {busy && (
                <Loader2 className="animate-spin" size={13} strokeWidth={1.85} aria-hidden />
              )}
              {status}
            </div>
          )}

          {error && !keyDetails && (
            <div className="weq-open-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="button"
            className="weq-action-primary weq-open-primary"
            onClick={selected.static ? () => void enter() : onAction}
            disabled={working}
          >
            {busy ? (
              <Loader2 className="weq-spin" size={17} aria-hidden />
            ) : (
              <ArrowRight size={17} aria-hidden />
            )}
            {busy ? '正在处理…' : '打开账号'}
          </button>

          {!selected.static && keyDetails && (
            <Modal
              open={keyDetails}
              centered
              labelledBy="account-key-title"
              onClose={() => setKeyDetails(false)}
              width={360}
              className="weq-key-recovery"
            >
              <div className="weq-dialog-head">
                <h3 className="weq-dialog-title" id="account-key-title">
                  输入数据库密钥
                </h3>
                <button
                  type="button"
                  className="weq-dialog-x"
                  title="关闭"
                  aria-label="关闭密钥详情"
                  onClick={() => setKeyDetails(false)}
                >
                  <X size={16} aria-hidden />
                </button>
              </div>
              <div className="weq-key-recovery-body">
                {selected.sourceDir && <div className="weq-open-path">{selected.sourceDir}</div>}
                <KeyField
                  key={choiceKey}
                  mode="new"
                  value={key}
                  onChange={setKey}
                  onAction={() => void enter(selected, key, false)}
                  busy={working}
                  showAction={false}
                />
                {error && (
                  <div className="weq-open-error" role="alert">
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  className="weq-action-primary"
                  disabled={working || !isCompleteKey(key)}
                  onClick={() => void enter(selected, key, false)}
                >
                  <ArrowRight size={14} aria-hidden />
                  打开账号
                </button>
                <button
                  type="button"
                  className="weq-action-soft"
                  disabled={working}
                  onClick={() => acquire(true)}
                >
                  <KeyRound size={14} aria-hidden />
                  重新获取密钥
                </button>
              </div>
            </Modal>
          )}

          <div className="weq-login-options">
            <label className="weq-auto-enter">
              <input
                type="checkbox"
                checked={autoEnter}
                disabled={working}
                onChange={(e) => setAutoChoice({ key: choiceKey, value: e.target.checked })}
              />
              <span>下次打开自动进入该账号</span>
            </label>
            <label className="weq-auto-enter">
              <input
                type="checkbox"
                checked={settings.data?.autoAttachQq ?? false}
                disabled={working || !settings.data || autoAttach.isLoading}
                onChange={(e) => autoAttach.mutate({ enabled: e.target.checked })}
              />
              <span>自动启用完整功能</span>
            </label>
          </div>
        </>
      ) : null}
      {mode === 'new' && (
        <button
          type="button"
          className="weq-action-soft weq-open-qr"
          disabled={working}
          onClick={startNewAccountQr}
        >
          <QrCode size={16} aria-hidden />
          扫码登录其他账号
        </button>
      )}
      {mode === 'new' && !selected && onDiagnostics && (
        <button
          type="button"
          className="weq-icon-button"
          title="环境诊断"
          aria-label="环境诊断"
          onClick={onDiagnostics}
        >
          <Settings2 size={16} aria-hidden />
        </button>
      )}
      {!selected && error && (
        <div className="weq-open-error" role="alert">
          {error}
        </div>
      )}
      {qr && (
        <QrDialog
          uin={qr.uin}
          name={qr.name}
          avatarUrl={qr.avatarUrl}
          status={qr.status}
          qrUrl={qr.url}
          anonymous={qr.anonymous}
          onClose={cancelQr}
        />
      )}
    </div>
  );
}

function formatQrState(state: string): string {
  switch (state) {
    case 'waiting-scan':
    case 'waiting':
      return '等待扫描';
    case 'waiting-confirm':
    case 'scanned':
      return '已扫码，请在手机上确认';
    case 'confirmed':
      return '已确认';
    case 'expired':
      return '二维码已过期';
    case 'canceled':
      return '已取消';
    case 'invalid':
      return '二维码失效';
    default:
      return state;
  }
}
