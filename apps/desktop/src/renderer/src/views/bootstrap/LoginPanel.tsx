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
  const confirm = useDialog((s) => s.confirm);
  const promptPassword = useDialog((s) => s.promptPassword);

  const [key, setKey] = useState('');
  /**
   * p_skey the login flow harvested alongside the dbkey. Handed to
   * `openAccount` so the home-dress fetch has a ticket even though QQ is
   * already gone. Empty for the alive-instance path (it can hook for one).
   */
  const pskeyRef = useRef<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [autoEnter, setAutoEnter] = useState(false);
  /** new mode only: which source to drive the wizard from. */
  const [source, setSource] = useState<'online' | 'backup'>('online');
  /** linux-only: alive-instance key fetch is slow & may need a manual message. */
  const [isLinux, setIsLinux] = useState(false);
  /** darwin-only: 在线实例走提权扫内存（SIP），失败后引导重启 QQ。 */
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    let alive = true;
    void client.bootstrap.systemInfo.query().then((info) => {
      if (alive) {
        setIsLinux(info.platformKind === 'linux');
        setIsMac(info.platformKind === 'darwin');
      }
    });
    return () => {
      alive = false;
    };
  }, []);

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
    // The ticket belongs to the account that was just logged in — never carry
    // it over to a different one.
    pskeyRef.current = null;
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

  async function acquire(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setStatus('正在探测在线实例…');
    try {
      const pid = await client.bootstrap.resolveQqPid.query({ uin: selected.uin });

      if (pid) {
        // The db path is resolved server-side from uin via the platform, so we
        // never build an OS-specific path here (that leaked `\` onto linux).

        // macOS：在线实例不注入 hook（SIP），改为提权扫内存直接恢复密钥；
        // 扫不到再引导「解除 SIP 重试 / 杀掉 QQ 重启取密钥」。
        if (isMac) {
          await acquireMac(pid, selected);
          return; // key set, or the dialog flow ended
        }

        // Linux: the alive-instance path goes through the pkexec-elevated
        // inject first (polkit dialog, untimed) and then the key fetch — the
        // native inject already waits for the hook to bind the MSFService
        // instance, so there is no packet-wait race on the fetch anymore.
        // Windows keeps the direct path.
        if (isLinux) {
          await acquireFromInstanceLinux(pid, selected);
          return; // key set, or an error was thrown
        }

        setStatus('正在从在线实例获取密钥…');
        const r = await client.bootstrap.fetchKeyFromInstance.mutate({ pid, uin: selected.uin });
        if (!r.success || !r.dbkey) {
          throw new Error(r.error ?? '依赖在线 QQ 客户端获取失败，请退出登录后重试。');
        }
        setKey(r.dbkey);
        setStatus('已获取密钥');
        setBusy(false);
        return;
      }

      if (selected.a1Key) {
        if (!(await ensureNineBirdInstalled())) {
          setBusy(false);
          setStatus('');
          return;
        }
        startQuickLogin(selected);
      } else {
        if (!(await ensureNineBirdInstalled())) {
          setBusy(false);
          setStatus('');
          return;
        }
        startQrLogin(selected);
      }
    } catch (e) {
      setBusy(false);
      setStatus('');
      showError('获取密钥失败', errMsg(e));
    }
  }

  /**
   * macOS 在线实例取密钥：
   *   1. 弹管理员密码框（ninebird 安装同款），提权扫 QQ 进程内存恢复 dbkey；
   *   2. 扫描失败 → 弹窗说明该账号在线 + pid，需要解除 SIP，可选「确认重启」；
   *   3. 确认重启 → 先查 NineBird 是否已装（已装不重复安装），未装则弹安装
   *      密码框提权安装，然后走 quick-login 拉起 QQ 取 dbkey + p_skey 等凭据
   *      （与 win/linux 的登录流程共用同一套 loader）。
   */
  async function acquireMac(pid: number, acc: UiAccount): Promise<void> {
    // Step 1 —— 提权扫内存。
    setStatus('正在扫描 QQ 进程内存（需要管理员权限）…');
    const password = await promptPassword(
      '获取数据库密钥',
      '需要管理员权限扫描 QQ 进程内存以获取数据库密钥（macOS 需先解除 SIP 才能读取其他进程内存）。' +
        '请输入电脑开机密码。',
      { placeholder: '管理员密码' },
    );
    if (password === null) {
      setBusy(false);
      setStatus('');
      return;
    }

    let scan: Awaited<ReturnType<typeof client.bootstrap.macScanKeyFromMemory.mutate>>;
    try {
      scan = await client.bootstrap.macScanKeyFromMemory.mutate({ uin: acc.uin, password });
    } catch (e) {
      setBusy(false);
      setStatus('');
      showError('获取密钥失败', errMsg(e));
      return;
    }

    if (scan.success && scan.key) {
      setKey(scan.key);
      setStatus('已获取密钥');
      setBusy(false);
      return;
    }

    const rawError = scan.error ?? '内存扫描未找到可用密钥';
    // 密码错误这类「不是 SIP 的问题」直接报错，不进重启引导。
    if (/密码|sudoers|sudo/i.test(rawError)) {
      setBusy(false);
      setStatus('');
      showError('获取密钥失败', rawError);
      return;
    }

    // Step 2 —— SIP 引导弹窗。
    setStatus('');
    const pidLabel = scan.pid > 0 ? scan.pid : pid;
    const restart = await confirm(
      '内存扫描失败',
      `该账号 QQ 在线，pid：${pidLabel}。扫描在线进程获取密钥需要解除 SIP，` +
        '您可以解除后重试，或者本程序将杀掉现在的 QQ，重启以获取密钥。',
      { okLabel: '确认重启', cancelLabel: '取消', tone: 'warning' },
    );
    if (!restart) {
      setBusy(false);
      return;
    }

    // Step 3 —— 确认重启：NineBird 已装就不重复安装，否则弹安装密码框。
    setStatus('正在检查 NineBird 安装状态…');
    let nineBirdReady = false;
    try {
      const status = await client.bootstrap.nineBirdInstallStatus.query();
      nineBirdReady = status?.kind === 'ninebird';
    } catch {
      nineBirdReady = false;
    }

    if (!nineBirdReady) {
      const installPassword = await promptPassword(
        'NineBird 安装',
        '需要管理员权限修改 QQ 程序入口（/Applications/QQ.app/Contents/Resources/app/package.json），' +
          '重启 QQ 以获取密钥。请输入电脑开机密码。',
        { placeholder: '管理员密码' },
      );
      if (installPassword === null) {
        setBusy(false);
        setStatus('');
        return;
      }
      try {
        await client.bootstrap.nineBirdInstall.mutate({ password: installPassword });
      } catch (e) {
        setBusy(false);
        setStatus('');
        showError('NineBird 安装失败', errMsg(e));
        return;
      }
    }

    // Step 4 —— 拉起 QQ 取 dbkey + p_skey（quick-login loader 顺带收集凭据）。
    setStatus('正在重启 QQ 并获取密钥…');
    startQuickLogin(acc);
  }

  /**
   * Linux alive-instance key fetch.
   *
   * The inject half (which pops the polkit password dialog and can take as long
   * as the user needs to type) runs FIRST and UNTIMED via `prepareInstanceInject`
   * — the native inject blocks until the hook binds the MSFService instance via
   * the account uin, so when it resolves the pid can already send OIDB packets
   * and the key fetch below is a plain request. Errors propagate to the caller,
   * which shows the error dialog.
   */
  async function acquireFromInstanceLinux(pid: number, acc: UiAccount): Promise<void> {
    // Step A (untimed): elevate + inject. The password dialog lives here.
    setStatus('正在注入 QQ 进程（可能弹出授权窗口，请输入密码）…');
    const prep = await client.bootstrap.prepareInstanceInject.mutate({ pid, uin: acc.uin });
    if (!prep.ok) {
      throw new Error(prep.error ?? '注入 QQ 进程失败，请重试。');
    }

    // Step B: fetch the key. The hook is already bound, so this is a plain
    // request — no stall race to guard anymore.
    setStatus('已注入，正在获取密钥…');
    const r = await client.bootstrap.fetchKeyFromInstance.mutate({ pid, uin: acc.uin });
    if (!r.success || !r.dbkey) {
      throw new Error(r.error ?? '依赖在线 QQ 客户端获取失败，请退出登录后重试。');
    }
    setKey(r.dbkey);
    setStatus('已获取密钥');
    setBusy(false);
  }

  /**
   * darwin：登录前确保 NineBird 已装好。未装（或入口已补丁但 bundle shim
   * 缺失）时弹管理员密码框提权安装；取消 / 失败返回 false 并已提示用户。
   * 其它平台直接放行（linux 的 pkexec / win32 的注入不依赖这一步）。
   */
  async function ensureNineBirdInstalled(): Promise<boolean> {
    if (!isMac) return true;
    try {
      const status = await client.bootstrap.nineBirdInstallStatus.query();
      if (status == null) return true;

      const needsInstall =
        status.kind === 'original' || (status.kind === 'ninebird' && status.loaderOk === false);
      if (!needsInstall) {
        if (status.kind !== 'ninebird') {
          showError(
            '无法自动安装 NineBird',
            status.kind === 'custom'
              ? `QQ 程序入口被其他程序占用（${status.main}）。请在「设置 → 全局设置」中先还原为原版 QQ，再重试。`
              : status.kind === 'missing'
                ? '未找到 QQ 入口配置，请确认 QQ 已安装。'
                : `读取 QQ 入口配置失败：${status.error}`,
          );
          return false;
        }
        return true;
      }

      const password = await promptPassword(
        'NineBird 安装',
        '登录流程需要重启 QQ 以获取密钥，需要管理员权限修改 QQ 程序入口。请输入电脑开机密码。',
        { placeholder: '管理员密码' },
      );
      if (password === null) return false;
      setStatus('正在安装 NineBird…');
      await client.bootstrap.nineBirdInstall.mutate({ password });
      setStatus('');
      return true;
    } catch (e) {
      showError('NineBird 安装失败', errMsg(e));
      return false;
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
              if (event.result.pskey) pskeyRef.current = event.result.pskey;
              setKey(event.result.dbkey);
              setStatus('已获取密钥');
              setBusy(false);
            } else if (event.result.hookInstallFailed) {
              // 注入失败服务层已自动重试过一次。二维码走的是同一条注入路径,
              // fallback 只会再失败一次 —— 直接请用户重试。
              setBusy(false);
              setStatus('');
              showError('快速登录失败', event.result.error ?? '请重试。');
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
            if (event.result.pskey) pskeyRef.current = event.result.pskey;
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

  /** 「登录新的账号」：先确保 NineBird 已装，再走匿名扫码。 */
  async function startNewAccountQr(): Promise<void> {
    if (!selected) return;
    if (!(await ensureNineBirdInstalled())) return;
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
        ...(pskeyRef.current ? { pskey: pskeyRef.current } : {}),
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
                <button
                  type="button"
                  className="weq-acct-new"
                  onClick={() => void startNewAccountQr()}
                >
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
  if (state === 'waiting') return '等待扫描';
  if (state === 'scanned') return '已扫描';
  if (state === 'confirmed') return '已确认';
  return state;
}
