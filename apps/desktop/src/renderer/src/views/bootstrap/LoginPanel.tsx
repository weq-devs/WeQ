/**
 * Left-pane login panel. Owns the per-account key lifecycle:
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
import { ArrowRight, Loader2, UserPlus } from 'lucide-react';
import { client } from '../../trpc/client';
import { useDialog } from '../../components/Dialog';
import type { AutoEnterTarget } from '@weq/service';
import { AccountSelector } from './AccountSelector';
import { KeyField, isCompleteKey } from './KeyField';
import { QrDialog } from './QrDialog';
import { StaticBackupPanel } from './StaticBackupPanel';
import type { UiAccount } from './types';

type Sub = { unsubscribe: () => void };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sameTarget(target: AutoEnterTarget | null, acc: UiAccount | null): boolean {
  if (!target || !acc) return false;
  return target.uin === acc.uin && (target.dataDir ?? '') === (acc.dataDir ?? '');
}

export function LoginPanel({
  mode,
  accounts,
  selected,
  onSelect,
  installRoot: _installRoot,
  autoTarget,
  onEntered,
  onDeleteAccount,
}: {
  mode: 'new' | 'existing';
  accounts: UiAccount[];
  selected: UiAccount | null;
  onSelect: (acc: UiAccount) => void;
  installRoot: string | null;
  autoTarget: AutoEnterTarget | null;
  onEntered: (uin: string) => void;
  onDeleteAccount?: (acc: UiAccount) => void;
}): ReactElement {
  const showError = useDialog((s) => s.showError);

  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [autoEnter, setAutoEnter] = useState(false);
  /** new mode only: which source to drive the wizard from. */
  const [source, setSource] = useState<'online' | 'backup'>('online');

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
    setKey(mode === 'existing' ? (selected?.dbKey ?? '') : '');
    setStatus('');
    setAutoEnter(sameTarget(autoTarget, selected));
    setSource('online');
  }, [selected?.key, mode, selected?.dbKey, autoTarget, selected]);

  // Tear down any live subscription on unmount.
  useEffect(() => () => subRef.current?.unsubscribe(), []);

  function closeSub(): void {
    subRef.current?.unsubscribe();
    subRef.current = null;
  }

  // ---- key acquisition (new mode) ----

  function acquire(): void {
    if (!selected) return;
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
    subRef.current = client.bootstrap.quickLogin.subscribe(
      { uin: acc.uin },
      {
        onData(event) {
          if (event.kind === 'state') {
            // Progress, including the "confirm on your phone" prompt.
            setStatus(event.message || event.state);
          } else if (event.kind === 'result') {
            closeSub();
            if (event.result.success && event.result.dbkey) {
              setKey(event.result.dbkey);
              setStatus('已获取密钥');
              setBusy(false);
            } else {
              // Quick login failed → fall back to QR.
              setStatus('快速登录失败，转二维码…');
              startQrLogin(acc);
            }
          }
        },
        onError() {
          closeSub();
          setStatus('快速登录失败，转二维码…');
          startQrLogin(acc);
        },
      },
    );
  }

  function startQrLogin(acc: UiAccount, anonymous = false): void {
    setStatus('正在获取二维码…');
    setQr({
      uin: acc.uin,
      name: acc.name,
      avatarUrl: acc.avatarUrl,
      status: '正在获取二维码…',
      url: null,
      anonymous,
    });
    closeSub();
    let seenUin = acc.uin;
    // 已知账号的扫码：把 uin 传给主进程，好让它定位该账号的 nt_msg.db 读
    // key_meta（否则 native 会因缺 key_meta 拿不到 dbkey）。「登录新的账号」是
    // 匿名扫码——当前选中的账号不是要登的那个，绝不能把它的 key_meta 带进去。
    const input = anonymous ? undefined : { uin: acc.uin };
    subRef.current = client.bootstrap.qrLogin.subscribe(input, {
      onData(event) {
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
            if (seenUin && seenUin !== selected?.uin) onSelectByUin(seenUin);
            setKey(event.result.dbkey);
            setStatus('已获取密钥');
            setBusy(false);
          } else {
            setBusy(false);
            setStatus('');
            showError('扫码登录失败', event.result.error ?? '请重试或更换登录方式。');
          }
        }
      },
      onError(e) {
        closeSub();
        setQr(null);
        setBusy(false);
        setStatus('');
        showError('扫码登录失败', errMsg(e));
      },
    });
  }

  function onSelectByUin(uin: string): void {
    const match = accounts.find((a) => a.uin === uin);
    if (match) onSelect(match);
  }

  /** 「登录新的账号」：直接走匿名扫码（登录本身不再需要任何安装步骤）。 */
  function startNewAccountQr(): void {
    if (!selected) return;
    startQrLogin(selected, true);
  }

  function cancelQr(): void {
    closeSub();
    setQr(null);
    setBusy(false);
    setStatus('');
  }

  // ---- enter (test then open) ----

  async function enter(): Promise<void> {
    if (!selected) return;

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
        setBusy(false);
        setStatus('');
        showError('进入失败', errMsg(e));
      }
      return;
    }

    const k = key.trim();
    if (mode === 'new' && !isCompleteKey(k)) {
      showError('密钥不完整', '请先获取或填入 16 位数据库密钥。');
      return;
    }
    setBusy(true);
    setStatus('正在验证密钥…');
    try {
      const test = await client.bootstrap.testDatabaseKey.mutate({ uin: selected.uin, dbKey: k });
      if (!test.success) {
        setBusy(false);
        setStatus('');
        showError('密钥验证失败', test.error ?? '数据库密钥不正确，无法进入。');
        return;
      }
      await client.bootstrap.openAccount.mutate({
        uin: selected.uin,
        dbKey: k,
        algo: test.algo,
        ...(selected.hasName ? { displayName: selected.name } : {}),
        ...(selected.avatarUrl ? { avatarUrl: selected.avatarUrl } : {}),
        ...(selected.dataDir ? { dataDir: selected.dataDir } : {}),
      });

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
      setBusy(false);
      setStatus('');
      showError('进入失败', errMsg(e));
    }
  }

  function onAction(): void {
    const k = key.trim();
    if (mode === 'existing' || isCompleteKey(k)) {
      void enter();
    } else {
      acquire();
    }
  }

  return (
    <div className="weq-login-panel">
      {mode === 'new' && (
        <nav className="weq-source-tabs" role="tablist" aria-label="账号来源">
          <button
            type="button"
            role="tab"
            aria-selected={source === 'online'}
            className={`weq-source-tab ${source === 'online' ? 'is-active' : ''}`}
            onClick={() => setSource('online')}
          >
            在线账号
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'backup'}
            className={`weq-source-tab ${source === 'backup' ? 'is-active' : ''}`}
            onClick={() => setSource('backup')}
          >
            本地备份
          </button>
        </nav>
      )}

      {mode === 'new' && source === 'backup' ? (
        <StaticBackupPanel onEntered={onEntered} />
      ) : (
        <>
          <AccountSelector
            accounts={accounts}
            selected={selected}
            onSelect={onSelect}
            onDeleteAccount={onDeleteAccount}
            footer={
              mode === 'new' ? (
                <button type="button" className="weq-acct-new" onClick={() => startNewAccountQr()}>
                  <UserPlus size={15} strokeWidth={1.8} aria-hidden />
                  登录新的账号
                </button>
              ) : undefined
            }
          />

          {status && (
            <div className="weq-login-status">
              {busy && (
                <Loader2 className="animate-spin" size={13} strokeWidth={1.85} aria-hidden />
              )}
              {status}
            </div>
          )}

          {selected?.static ? (
            <button
              type="button"
              className="weq-action-primary weq-static-enter"
              onClick={() => void enter()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="animate-spin" size={15} strokeWidth={1.8} aria-hidden />
              ) : (
                <ArrowRight size={15} strokeWidth={1.85} aria-hidden />
              )}
              进入（静态离线账号）
            </button>
          ) : (
            <KeyField mode={mode} value={key} onChange={setKey} onAction={onAction} busy={busy} />
          )}

          <label className="weq-auto-enter">
            <input
              type="checkbox"
              checked={autoEnter}
              onChange={(e) => setAutoEnter(e.target.checked)}
            />
            <span>下次打开自动进入该账号</span>
          </label>

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
        </>
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
