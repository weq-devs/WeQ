/**
 * Left-pane login panel. Owns the per-account key lifecycle:
 *
 *   获取密钥 (new mode) — fresh online probe dispatches to the right flow:
 *       online instance → fetch via OIDB (fail ⇒ "退出登录后重试", no fallback)
 *       quick-login-able → quick login   (fail ⇒ fall back to QR)
 *       otherwise        → QR login       (fail ⇒ error dialog)
 *   进入 — ALWAYS tests the key first (testDatabaseKey); a wrong key shows an
 *       error dialog and refuses entry. On success opens the account and,
 *       when ticked, records the global "auto-enter" target.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { client } from '../../trpc/client';
import { useDialog } from '../../components/Dialog';
import type { AutoEnterTarget } from '@weq/service';
import { AccountSelector } from './AccountSelector';
import { KeyField, isCompleteKey } from './KeyField';
import { QrDialog } from './QrDialog';
import { deriveMsgDbPath, type UiAccount } from './types';

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
  installRoot,
  allUins,
  autoTarget,
  onEntered,
}: {
  mode: 'new' | 'existing';
  accounts: UiAccount[];
  selected: UiAccount | null;
  onSelect: (acc: UiAccount) => void;
  installRoot: string | null;
  allUins: string[];
  autoTarget: AutoEnterTarget | null;
  onEntered: (uin: string) => void;
}): ReactElement {
  const showError = useDialog((s) => s.showError);

  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [autoEnter, setAutoEnter] = useState(false);

  // QR dialog state
  const [qr, setQr] = useState<{ uin: string; name: string; avatarUrl: string | null; status: string; url: string | null } | null>(null);
  const subRef = useRef<Sub | null>(null);

  // Reset the key + flags whenever the selected account changes.
  useEffect(() => {
    setKey(mode === 'existing' ? (selected?.dbKey ?? '') : '');
    setStatus('');
    setAutoEnter(sameTarget(autoTarget, selected));
  }, [selected?.key, mode, selected?.dbKey, autoTarget, selected]);

  // Tear down any live subscription on unmount.
  useEffect(() => () => subRef.current?.unsubscribe(), []);

  function closeSub(): void {
    subRef.current?.unsubscribe();
    subRef.current = null;
  }

  // ---- key acquisition (new mode) ----

  async function acquire(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setStatus('正在探测在线实例…');
    try {
      const [procs, probe] = await Promise.all([
        client.bootstrap.detectRunningProcesses.query(),
        client.bootstrap.probeOnline.query({ knownUins: allUins }),
      ]);
      let pid = procs.find((p) => p.loginInfo?.loggedIn && p.loginInfo.uin === selected.uin)?.pid;
      if (!pid && procs.length === 1 && probe.byUin?.[selected.uin]) pid = procs[0]?.pid;

      if (pid) {
        if (!installRoot) throw new Error('未找到 Tencent Files 目录，请先在右侧选择数据目录。');
        setStatus('正在从在线实例获取密钥…');
        const dbPath = deriveMsgDbPath(installRoot, selected.uin);
        const r = await client.bootstrap.fetchKeyFromInstance.mutate({ pid, dbPath });
        if (!r.success || !r.dbkey) {
          throw new Error(r.error ?? '依赖在线 QQ 客户端获取失败，请退出登录后重试。');
        }
        setKey(r.dbkey);
        setStatus('已获取密钥');
        setBusy(false);
        return;
      }

      if (selected.a1Key) {
        startQuickLogin(selected);
      } else {
        startQrLogin(selected);
      }
    } catch (e) {
      setBusy(false);
      setStatus('');
      showError('获取密钥失败', errMsg(e));
    }
  }

  function startQuickLogin(acc: UiAccount): void {
    setStatus('正在快速登录…');
    closeSub();
    subRef.current = client.bootstrap.quickLogin.subscribe(
      { uin: acc.uin },
      {
        onData(event) {
          if (event.kind === 'login-list') {
            setStatus(`读取到 ${event.list.length} 个账号…`);
          } else if (event.kind === 'result') {
            closeSub();
            if (event.result.success && event.result.dbkey) {
              setKey(event.result.dbkey);
              setStatus('已获取密钥');
              setBusy(false);
            } else {
              // Quick login failed → fall back to QR (per spec).
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

  function startQrLogin(acc: UiAccount): void {
    setStatus('正在获取二维码…');
    setQr({ uin: acc.uin, name: acc.name, avatarUrl: acc.avatarUrl, status: '正在获取二维码…', url: null });
    closeSub();
    let seenUin = acc.uin;
    subRef.current = client.bootstrap.qrLogin.subscribe(undefined, {
      onData(event) {
        if (event.kind === 'login-list') {
          const first = event.list[0];
          if (first?.uin) seenUin = first.uin;
        } else if (event.kind === 'qrcode') {
          setQr((q) => (q ? { ...q, url: event.url, status: '请使用手机 QQ 扫码' } : q));
        } else if (event.kind === 'qrcode-state') {
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

  function cancelQr(): void {
    closeSub();
    setQr(null);
    setBusy(false);
    setStatus('');
  }

  // ---- enter (test then open) ----

  async function enter(): Promise<void> {
    if (!selected) return;
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
      void acquire();
    }
  }

  return (
    <div className="weq-login-panel">
      <AccountSelector
        accounts={accounts}
        selected={selected}
        onSelect={onSelect}
        footer={
          mode === 'new' ? (
            <button
              type="button"
              className="weq-acct-new"
              onClick={() => selected && startQrLogin(selected)}
            >
              <UserPlus size={15} strokeWidth={1.8} aria-hidden />
              登录新的账号
            </button>
          ) : undefined
        }
      />

      {status && (
        <div className="weq-login-status">
          {busy && <Loader2 className="animate-spin" size={13} strokeWidth={1.85} aria-hidden />}
          {status}
        </div>
      )}

      <KeyField
        mode={mode}
        value={key}
        onChange={setKey}
        onAction={onAction}
        busy={busy}
      />

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
          onClose={cancelQr}
        />
      )}
    </div>
  );
}

function formatQrState(state: string): string {
  if (state === 'waiting') return '等待扫描';
  if (state === 'scanned') return '已扫描';
  if (state === 'confirmed') return '已确认';
  return state;
}
