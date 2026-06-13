/**
 * Screen 2 — pick an account + acquire dbkey.
 *
 * Renders three sections corresponding to the three priority bands the
 * spec calls out:
 *
 *   0. Saved configurations (config/accounts/*.json) → Direct login
 *   1. Accounts with a live, logged-in QQ process  → fetchKeyFromInstance
 *   2. login.db accounts with a non-empty a1Key    → quickLogin (fallback QR on fail)
 *   3. login.db accounts with empty a1Key          → QR only
 *   4. "Other" — manual UIN entry                  → QR only
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import { trpc } from '../trpc/client';
import { client } from '../trpc/client';
import { useViewState } from '../state/view';
import { QrImage } from '../components/QrImage';
import type { LoginAccount, QqPortLoginInfo } from '@weq/native';
import type { AccountConfig } from '@weq/service';

export function PickAccountView(): ReactElement {
  const accounts = trpc.bootstrap.listAccounts.useQuery(undefined, { retry: false });
  const savedConfigs = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    refetchOnMount: true,
  });
  const processes = trpc.bootstrap.detectRunningProcesses.useQuery(undefined, {
    refetchOnMount: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [obtainedKey, setObtainedKey] = useState<string | null>(null);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  const goTo = useViewState((s) => s.goTo);

  function onKey(uin: string, key: string): void {
    setObtainedKey(key);
    setError(null);
    // Confirm step: open account and transition.
    void client.bootstrap.openAccount
      .mutate({ uin, dbKey: key })
      .then(() => {
        setOpenedUin(uin);
        goTo('main');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }

  // ---- bucketize ----
  const procByUin = new Map<string, QqPortLoginInfo & { pid: number }>();
  for (const p of processes.data ?? []) {
    if (p.loginInfo?.loggedIn && p.loginInfo.uin) {
      procByUin.set(p.loginInfo.uin, { ...p.loginInfo, pid: p.pid });
    }
  }
  const accountList: LoginAccount[] = accounts.data ?? [];

  const aliveAccounts = accountList.filter((a) => procByUin.has(a.uin));
  const quickAccounts = accountList.filter(
    (a) => !procByUin.has(a.uin) && a.a1Key !== '',
  );
  const qrOnlyAccounts = accountList.filter(
    (a) => !procByUin.has(a.uin) && a.a1Key === '',
  );

  return (
    <main className="p-6 font-sans leading-relaxed text-sm">
      <button 
        onClick={() => goTo('bootstrap')} 
        className="mb-4 px-3 py-1 text-xs border border-border rounded-md hover:bg-accent transition-colors"
      >
        ← 返回诊断
      </button>
      <h1 className="text-2xl font-bold mb-4 text-foreground">选择账号</h1>

      <TencentFilesRow />

      {error && (
        <p className="text-destructive font-medium my-2 bg-destructive/5 p-2 rounded-md border border-destructive/10">错误: {error}</p>
      )}

      {obtainedKey && (
        <p className="text-green-600 font-medium my-2 bg-green-50 p-2 rounded-md border border-green-100">
          数据库密钥已获取: <code className="bg-white px-1 rounded border border-green-200 ml-1">{obtainedKey}</code>
        </p>
      )}

      {(savedConfigs.data?.length ?? 0) > 0 && (
        <Section title="0) 快速开始 (已保存的配置)">
          {savedConfigs.data?.map((cfg) => (
            <SavedConfigRow 
              key={cfg.uin} 
              cfg={cfg} 
              onKey={onKey} 
              onDelete={() => savedConfigs.refetch()}
            />
          ))}
        </Section>
      )}

      <Section title="1) 正在运行的 QQ (推荐)">
        {aliveAccounts.length === 0 ? (
          <p className="text-muted-foreground italic text-xs py-2">没有发现已登录的匹配账号</p>
        ) : (
          aliveAccounts.map((a) => {
            const proc = procByUin.get(a.uin)!;
            return (
              <AliveRow key={a.uin} acc={a} pid={proc.pid} onKey={onKey} onError={setError} />
            );
          })
        )}
      </Section>

      <Section title="2) 快速登录 (利用缓存登录信息)">
        {quickAccounts.length === 0 ? (
          <p className="text-muted-foreground italic text-xs py-2">(无可用账号)</p>
        ) : (
          quickAccounts.map((a) => (
            <QuickRow key={a.uin} acc={a} onKey={onKey} onError={setError} />
          ))
        )}
      </Section>

      <Section title="3) 扫码登录 (需要手机确认)">
        {qrOnlyAccounts.length === 0 ? (
          <p className="text-muted-foreground italic text-xs py-2">(无可用账号)</p>
        ) : (
          qrOnlyAccounts.map((a) => (
            <QrRow key={a.uin} acc={a} onKey={onKey} onError={setError} />
          ))
        )}
      </Section>

      <Section title="4) 其他账号 (手动扫码)">
        <QrRow acc={null} onKey={onKey} onError={setError} />
      </Section>

      <Section title="5) 手动输入密钥">
        <ManualEntry onKey={onKey} />
      </Section>
    </main>
  );
}

// ---------- small building blocks ----------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="mt-8 first:mt-4">
      <h2 className="text-base font-bold border-b border-border pb-1.5 mb-4 text-foreground/80">{title}</h2>
      <div className="space-y-1">
        {children}
      </div>
    </section>
  );
}

function AliveRow({
  acc,
  pid,
  onKey,
  onError,
}: {
  acc: LoginAccount;
  pid: number;
  onKey: (uin: string, key: string) => void;
  onError: (msg: string) => void;
}): ReactElement {
  const [pending, setPending] = useState(false);
  const userRoot = useViewState((s) => s.tencentFilesRoot);

  async function go(): Promise<void> {
    setPending(true);
    try {
      const dbPath = await derivePath(acc.uin, userRoot);
      const r = await client.bootstrap.fetchKeyFromInstance.mutate({ pid, dbPath });
      if (!r.success || !r.dbkey) {
        onError(r.error ?? '无法从进程获取密钥');
        return;
      }
      onKey(acc.uin, r.dbkey);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Row acc={acc}>
      <span className="mr-2 text-muted-foreground tabular-nums text-xs bg-muted px-1.5 py-0.5 rounded">PID={pid}</span>
      <button 
        onClick={() => void go()} 
        disabled={pending}
        className="px-3 py-1 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 transition-all text-xs shadow-sm shadow-primary/10"
      >
        {pending ? '获取中…' : '一键获取密钥'}
      </button>
    </Row>
  );
}

function QuickRow({
  acc,
  onKey,
  onError,
}: {
  acc: LoginAccount;
  onKey: (uin: string, key: string) => void;
  onError: (msg: string) => void;
}): ReactElement {
  const [status, setStatus] = useState<string>('待命');

  function go(): void {
    setStatus('正在启动…');
    client.bootstrap.quickLogin.subscribe(
      { uin: acc.uin },
      {
        onData(e) {
          if (e.kind === 'login-list') setStatus(`获取到列表 (${e.list.length})`);
          else if (e.kind === 'result') {
            if (e.result.success && e.result.dbkey) onKey(acc.uin, e.result.dbkey);
            else onError(e.result.error ?? '快速登录失败');
            setStatus('待命');
          }
        },
        onError(e) {
          onError(e instanceof Error ? e.message : String(e));
          setStatus('待命');
        },
      },
    );
  }

  return (
    <Row acc={acc}>
      <span className="mr-2 text-muted-foreground text-xs">{status}</span>
      <button 
        onClick={go} 
        disabled={status !== '待命'}
        className="px-3 py-1 bg-secondary text-secondary-foreground rounded-md hover:bg-accent disabled:opacity-50 transition-all text-xs border border-border/50"
      >
        快速登录
      </button>
    </Row>
  );
}

function QrRow({
  acc,
  onKey,
  onError,
}: {
  acc: LoginAccount | null;
  onKey: (uin: string, key: string) => void;
  onError: (msg: string) => void;
}): ReactElement {
  const [status, setStatus] = useState<string>('待命');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [uin, setUin] = useState<string>(acc?.uin ?? '');

  function go(): void {
    setStatus('获取二维码…');
    setQrUrl(null);
    client.bootstrap.qrLogin.subscribe(undefined, {
      onData(e) {
        if (e.kind === 'qrcode') {
          setQrUrl(e.url);
          setStatus('请扫描二维码');
        } else if (e.kind === 'qrcode-state') {
          setStatus(e.state === 'waiting' ? '等待扫描' : e.state === 'scanned' ? '已扫描' : e.state);
        } else if (e.kind === 'result') {
          if (e.result.success && e.result.dbkey && uin) {
            onKey(uin, e.result.dbkey);
          } else if (!uin) {
            onError('扫码前请输入该账号的 UIN');
          } else {
            onError(e.result.error ?? '扫码登录失败');
          }
          setStatus('待命');
          setQrUrl(null);
        }
      },
      onError(e) {
        onError(e instanceof Error ? e.message : String(e));
        setStatus('待命');
      },
    });
  }

  return (
    <div className="mb-4 last:mb-0">
      <Row acc={acc}>
        {acc === null && (
          <input
            placeholder="账号 (UIN)"
            value={uin}
            onChange={(e) => setUin(e.target.value)}
            className="mr-2 px-2 py-1 border border-input rounded-md bg-background text-xs w-32 focus:ring-1 focus:ring-primary outline-none transition-all"
          />
        )}
        <span className="mr-2 text-muted-foreground italic text-[11px]">{status}</span>
        <button 
          onClick={go} 
          disabled={status !== '待命' && status !== '请扫描二维码'}
          className="px-3 py-1 border border-border rounded-md hover:bg-accent disabled:opacity-50 transition-all text-xs"
        >
          扫码登录
        </button>
      </Row>
      {qrUrl && (
        <div className="ml-10 mt-3 p-3 bg-white border border-border/50 inline-flex flex-col items-center rounded-xl shadow-lg shadow-black/5 animate-in fade-in zoom-in duration-200">
          <QrImage url={qrUrl} size={144} />
          <p className="text-[10px] text-center mt-2 text-muted-foreground font-medium">使用 QQ 手机端扫码</p>
        </div>
      )}
    </div>
  );
}

function ManualEntry({ onKey }: { onKey: (uin: string, key: string) => void }): ReactElement {
  const [uin, setUin] = useState('');
  const [key, setKey] = useState('');
  return (
    <div className="flex items-center gap-2 py-2">
      <input
        placeholder="账号 (UIN)"
        value={uin}
        onChange={(e) => setUin(e.target.value)}
        className="px-2 py-1 border border-input rounded-md bg-background w-32 text-xs focus:ring-1 focus:ring-primary outline-none"
      />
      <input
        placeholder="数据库密钥 (dbkey)"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className="px-2 py-1 border border-input rounded-md bg-background w-64 font-mono text-xs focus:ring-1 focus:ring-primary outline-none"
      />
      <button 
        onClick={() => onKey(uin.trim(), key.trim())} 
        disabled={!uin || !key}
        className="px-4 py-1 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 text-xs transition-all shadow-sm"
      >
        以此密钥登录
      </button>
    </div>
  );
}

function SavedConfigRow({
  cfg,
  onKey,
  onDelete,
}: {
  cfg: AccountConfig;
  onKey: (uin: string, key: string) => void;
  onDelete: () => void;
}): ReactElement {
  const deleteConfig = trpc.bootstrap.deleteAccountConfig.useMutation();

  return (
    <Row acc={cfg}>
      <div className="flex gap-2">
        <button
          onClick={() => onKey(cfg.uin, cfg.dbKey)}
          className="px-3 py-1 bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-all text-xs shadow-sm shadow-primary/10"
        >
          以此配置登录
        </button>
        <button
          onClick={async () => {
            if (confirm(`确定要删除账号 ${cfg.uin} 的配置吗？`)) {
              await deleteConfig.mutateAsync({ uin: cfg.uin });
              onDelete();
            }
          }}
          className="px-2 py-1 border border-border rounded-md hover:bg-destructive hover:text-destructive-foreground transition-all text-[10px]"
        >
          删除
        </button>
      </div>
    </Row>
  );
}

function Row({
  acc,
  children,
}: {
  acc: LoginAccount | AccountConfig | null;
  children: ReactNode;
}): ReactElement {
  const uin = acc?.uin;
  const name =
    acc && 'userName' in acc
      ? (acc as LoginAccount).userName
      : (acc as AccountConfig)?.displayName;

  return (
    <div className="py-1.5 flex items-center gap-4">
      {acc && (
        <>
          <img
            src={`https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0`}
            alt=""
            width={32}
            height={32}
            className="rounded-full ring-2 ring-background shadow-sm bg-muted"
            onError={(e) => (e.target as HTMLImageElement).classList.add('hidden')}
          />
          <span className="min-w-[180px] font-semibold text-foreground/90">
            {name ? (
              <>
                {name}{' '}
                <span className="text-muted-foreground font-normal text-[11px] ml-1">
                  ({uin})
                </span>
              </>
            ) : (
              uin
            )}
          </span>
        </>
      )}
      {children}
    </div>
  );
}

/**
 * Helper: derive the absolute nt_msg.db path from a uin.
 *
 * Priority:
 *   1. User-picked Tencent Files root (from the dialog) if set.
 *   2. First auto-discovered root from `describeInstall`.
 *   3. Throw — caller should surface a "browse to your Tencent Files folder" hint.
 */
async function derivePath(uin: string, userRoot: string | null): Promise<string> {
  if (userRoot) {
    return `${userRoot}\\${uin}\\nt_qq\\nt_db\\nt_msg.db`;
  }
  const install = await client.bootstrap.describeInstall.query();
  for (const root of install.tencentFilesRoots) {
    return `${root}\\${uin}\\nt_qq\\nt_db\\nt_msg.db`;
  }
  throw new Error('未发现 Tencent Files 目录，请在上方手动选择。');
}

// ---------- Tencent Files root row ---------------------------------------

function TencentFilesRow(): ReactElement {
  const install = trpc.bootstrap.describeInstall.useQuery();
  const userRoot = useViewState((s) => s.tencentFilesRoot);
  const setUserRoot = useViewState((s) => s.setTencentFilesRoot);

  const autoRoot = install.data?.tencentFilesRoots[0] ?? null;
  const effective = userRoot ?? autoRoot;

  async function browse(): Promise<void> {
    const picked = await client.bootstrap.pickTencentFilesRoot.mutate();
    if (picked) setUserRoot(picked);
  }

  return (
    <section className="my-5 p-3.5 border border-border rounded-xl flex items-center gap-3 bg-secondary/20 text-xs border-dashed">
      <strong className="text-xs shrink-0 font-bold text-foreground/70">数据存放目录:</strong>
      <span className="font-mono flex-1 truncate text-muted-foreground/80 italic text-[11px]">
        {effective ?? '(未发现，请手动选择)'}
      </span>
      <div className="flex gap-2 shrink-0">
        {userRoot && (
          <button 
            onClick={() => setUserRoot(null)} 
            title="恢复自动检测路径"
            className="px-2.5 py-1 border border-border rounded-md hover:bg-background transition-colors text-[11px]"
          >
            重置
          </button>
        )}
        <button 
          onClick={() => void browse()}
          className="px-2.5 py-1 bg-background border border-border rounded-md hover:bg-accent transition-colors text-[11px] shadow-sm font-medium"
        >
          更改目录…
        </button>
      </div>
    </section>
  );
}
