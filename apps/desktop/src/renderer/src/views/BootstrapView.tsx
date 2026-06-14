import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type UIEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  Check,
  Database,
  FolderOpen,
  KeyRound,
  Loader2,
  Monitor,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { trpc } from '../trpc/client';
import { client } from '../trpc/client';
import { useViewState } from '../state/view';
import { QrImage } from '../components/QrImage';
import type { AccountConfig } from '@weq/service';
import type { LoginAccount, QqPortLoginInfo } from '@weq/native';

type AccountBand = {
  key: string;
  title: string;
  detail: string;
  children: ReactNode;
};

type QrDialogAccount = {
  name: string;
  qqNumber: string;
  identityHint: string;
  avatarUrl: string | null;
};

const ACCOUNT_ROW_HEIGHT = 58;
const ACCOUNT_VIEWPORT_ROWS = 4;
const ACCOUNT_OVERSCAN = 2;

export function BootstrapView(): ReactElement {
  const install = trpc.bootstrap.describeInstall.useQuery();
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

  const preparing =
    install.isLoading || accounts.isLoading || savedConfigs.isLoading || processes.isLoading;

  const procByUin = useMemo(() => {
    const map = new Map<string, QqPortLoginInfo & { pid: number }>();
    for (const p of processes.data ?? []) {
      if (p.loginInfo?.loggedIn && p.loginInfo.uin) {
        map.set(p.loginInfo.uin, { ...p.loginInfo, pid: p.pid });
      }
    }
    return map;
  }, [processes.data]);

  const accountList: LoginAccount[] = accounts.data ?? [];
  const aliveAccounts = accountList.filter((a) => procByUin.has(a.uin));
  const quickAccounts = accountList.filter(
    (a) => !procByUin.has(a.uin) && a.a1Key !== '',
  );
  const qrOnlyAccounts = accountList.filter(
    (a) => !procByUin.has(a.uin) && a.a1Key === '',
  );

  const installRows = [
    { label: '主程序', value: install.data?.qqExePath ?? '未找到' },
    { label: '核心组件', value: install.data?.wrapperNodePath ?? '未找到' },
    { label: '登录数据库', value: install.data?.loginDbPath ?? '未找到' },
  ];

  const processRows = processes.data ?? [];
  const savedConfigList = savedConfigs.data ?? [];

  const priorityBands: AccountBand[] = [
    {
      key: 'saved',
      title: '已保存配置',
      detail: '直接打开上次确认过的本地数据库密钥',
      children:
        savedConfigList.length > 0 ? (
          <VirtualRows
            items={savedConfigList}
            rowKey={(cfg) => cfg.uin}
            renderItem={(cfg) => (
              <SavedConfigRow
                cfg={cfg}
                onKey={onKey}
                onDelete={() => {
                  void savedConfigs.refetch();
                }}
              />
            )}
          />
        ) : (
          <EmptyLine>暂无保存配置</EmptyLine>
        ),
    },
  ];

  const loginBands: AccountBand[] = [
    {
      key: 'alive',
      title: '运行中的 QQ',
      detail: '优先从已登录实例读取密钥',
      children:
        aliveAccounts.length > 0 ? (
          <VirtualRows
            items={aliveAccounts}
            rowKey={(acc) => acc.uin}
            renderItem={(acc) => {
              const proc = procByUin.get(acc.uin)!;
              return (
                <AliveRow
                  acc={acc}
                  pid={proc.pid}
                  onKey={onKey}
                  onError={setError}
                />
              );
            }}
          />
        ) : (
          <EmptyLine>没有发现已登录的匹配账号</EmptyLine>
        ),
    },
    {
      key: 'quick',
      title: '快速登录',
      detail: '使用本机缓存登录信息获取密钥',
      children:
        quickAccounts.length > 0 ? (
          <VirtualRows
            items={quickAccounts}
            rowKey={(acc) => acc.uin}
            renderItem={(acc) => (
              <QuickRow acc={acc} onKey={onKey} onError={setError} />
            )}
          />
        ) : (
          <EmptyLine>无可用账号</EmptyLine>
        ),
    },
    {
      key: 'qr',
      title: '扫码登录',
      detail: '需要手机 QQ 确认',
      children:
        qrOnlyAccounts.length > 0 ? (
          <VirtualRows
            items={qrOnlyAccounts}
            rowKey={(acc) => acc.uin}
            renderItem={(acc) => <QrRow acc={acc} onKey={onKey} onError={setError} />}
          />
        ) : (
          <EmptyLine>无可用账号</EmptyLine>
        ),
    },
  ];

  function onKey(uin: string, key: string): void {
    if (!uin.trim() || !key.trim()) {
      setError('账号和数据库密钥不能为空');
      return;
    }

    setObtainedKey(key);
    setError(null);
    void client.bootstrap.openAccount
      .mutate({ uin: uin.trim(), dbKey: key.trim() })
      .then(() => {
        setOpenedUin(uin.trim());
        goTo('main');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }

  function refreshAll(): void {
    void install.refetch();
    void accounts.refetch();
    void savedConfigs.refetch();
    void processes.refetch();
  }

  return (
    <main className="weq-home-shell h-screen overflow-hidden font-sans text-[#142235]">
      <div className="relative z-10 grid h-full grid-cols-[minmax(300px,0.88fr)_minmax(520px,1.25fr)] gap-8 px-8 py-6">
        <section className="flex min-h-0 flex-col overflow-hidden">
          <header className="pt-1">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium text-[#0099ff]">QQ NT 本地数据工具</p>
                <h1 className="weq-display mt-1 text-[34px] font-normal leading-none tracking-normal text-[#071f3d]">
                  WeQ
                </h1>
              </div>
              <button
                onClick={refreshAll}
                className="weq-icon-button"
                title="刷新检测结果"
                aria-label="刷新检测结果"
              >
                <RefreshCw
                  aria-hidden
                  className={preparing ? 'animate-spin' : ''}
                  size={17}
                  strokeWidth={1.8}
                />
              </button>
            </div>
          </header>

          <div className="mt-5 grid grid-cols-3 border-y border-[#0099ff]/18">
            <Metric label="账号" value={accountList.length} />
            <Metric label="进程" value={processRows.length} />
            <Metric label="配置" value={savedConfigList.length} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-5">
            <InstallIndex
              loading={install.isLoading}
              rows={installRows}
              roots={install.data?.tencentFilesRoots ?? []}
            />
            <ProcessIndex loading={processes.isLoading} rows={processRows} />
            <TencentFilesRow />
            <div className="weq-priority-list">
              {priorityBands.map((band) => (
                <AccountBand key={band.key} title={band.title} detail={band.detail}>
                  {band.children}
                </AccountBand>
              ))}
            </div>
          </div>
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden border-l border-[#0099ff]/18 pl-8">
          <header className="flex items-start justify-between gap-5 border-b border-[#0099ff]/18 pb-4">
            <div>
              <p className="text-[13px] font-medium text-[#0099ff]">账号入口</p>
              <h2 className="weq-display mt-1 text-[25px] font-normal leading-tight text-[#0a2847]">
                选择登录方式
              </h2>
            </div>
            {preparing && (
              <span className="inline-flex items-center gap-2 rounded-full border border-[#0099ff]/20 bg-white/58 px-3 py-1.5 text-[13px] text-[#0099ff]">
                <Loader2 aria-hidden className="animate-spin" size={15} strokeWidth={1.8} />
                正在检测
              </span>
            )}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto py-4">
            {error && (
              <Feedback tone="error">
                <span className="font-medium">处理失败：</span>
                {error}
              </Feedback>
            )}
            {obtainedKey && (
              <Feedback tone="success">
                <span className="font-medium">数据库密钥已获取：</span>
                <code className="ml-1 break-all font-mono text-[12px] text-[#24513d]">
                  {obtainedKey}
                </code>
              </Feedback>
            )}

            <div className="weq-account-list">
              {loginBands.map((band) => (
                <AccountBand key={band.key} title={band.title} detail={band.detail}>
                  {band.children}
                </AccountBand>
              ))}
              <AccountBand title="其他账号" detail="手动填写 UIN 后扫码">
                <QrRow acc={null} onKey={onKey} onError={setError} />
              </AccountBand>
              <AccountBand title="手动输入密钥" detail="已有 dbkey 时直接验证打开">
                <ManualEntry onKey={onKey} />
              </AccountBand>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="border-r border-[#0099ff]/15 px-4 py-3 last:border-r-0">
      <div className="weq-number text-[26px] leading-none text-[#0099ff]">{value}</div>
      <div className="mt-1 text-[13px] text-[#31445a]">{label}</div>
    </div>
  );
}

function InstallIndex({
  loading,
  rows,
  roots,
}: {
  loading: boolean;
  rows: Array<{ label: string; value: string }>;
  roots: string[];
}): ReactElement {
  return (
    <section className="weq-system-section">
      <SectionTitle
        icon={<Database size={17} strokeWidth={1.75} aria-hidden />}
        title="QQ 安装信息"
        loading={loading}
      />
      <div className="weq-install-index">
        {rows.map((row) => (
          <KeyValueRow key={row.label} label={row.label} value={row.value} />
        ))}
        {roots.length === 0 ? (
          <KeyValueRow label="Tencent Files 数据目录" value="未发现" />
        ) : (
          roots.map((path, index) => (
            <KeyValueRow
              key={path}
              label={index === 0 ? 'Tencent Files 数据目录' : ' '}
              value={path}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ProcessIndex({
  loading,
  rows,
}: {
  loading: boolean;
  rows: Array<{ pid: number; loginInfo: QqPortLoginInfo | null }>;
}): ReactElement {
  return (
    <section className="weq-system-section">
      <SectionTitle
        icon={<Monitor size={17} strokeWidth={1.75} aria-hidden />}
        title="正在运行的 QQ 进程"
        loading={loading}
      />
      {rows.length === 0 ? (
        <EmptyLine>未发现运行中的 QQ</EmptyLine>
      ) : (
        <div className="weq-process-list">
          {rows.map((process) => (
            <ProcessLine key={process.pid} process={process} />
          ))}
        </div>
      )}
    </section>
  );
}

function SectionTitle({
  icon,
  title,
  loading,
}: {
  icon: ReactNode;
  title: string;
  loading?: boolean;
}): ReactElement {
  return (
    <div className="weq-section-title">
      <h2 className="flex items-center gap-2 text-[16px] font-medium text-[#102b47]">
        <span className="weq-line-icon">{icon}</span>
        {title}
      </h2>
      {loading && (
        <Loader2
          aria-label="正在加载"
          className="animate-spin text-[#0099ff]"
          size={16}
          strokeWidth={1.8}
        />
      )}
    </div>
  );
}

function KeyValueRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="weq-key-row">
      <span className="weq-key-label">{label}</span>
      <PathLine value={value} />
    </div>
  );
}

function PathLine({ value }: { value: string }): ReactElement {
  return (
    <span className="weq-path-line">
      {value}
    </span>
  );
}

function ProcessLine({
  process,
}: {
  process: { pid: number; loginInfo: QqPortLoginInfo | null };
}): ReactElement {
  const info = process.loginInfo;
  const label = info
    ? `账号 ${info.uin || '未知'} · ${info.loggedIn ? '已登录' : '未登录'} · 端口 ${info.port}`
    : '无法获取端口信息';

  return (
    <div className="weq-process-row">
      <span className="min-w-0 truncate text-[13px] text-[#1d3147]">{label}</span>
      <span className="weq-number text-[14px] text-[#0099ff]">PID {process.pid}</span>
    </div>
  );
}

function Feedback({
  tone,
  children,
}: {
  tone: 'error' | 'success';
  children: ReactNode;
}): ReactElement {
  const className =
    tone === 'error'
      ? 'border-[#9f2d35]/22 bg-[#fff5f5]/82 text-[#7b2730]'
      : 'border-[#2f8b66]/22 bg-[#f1fbf5]/82 text-[#24513d]';

  return (
    <div className={`mb-3 border-l-2 px-3 py-2 text-[13px] leading-5 ${className}`}>
      {children}
    </div>
  );
}

function AccountBand({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="weq-band">
      <div className="weq-band-head">
        <h3 className="weq-display text-[18px] font-normal text-[#0f2d4c]">{title}</h3>
        <p className="text-[13px] text-[#3c5368]">{detail}</p>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

function EmptyLine({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="weq-empty-line">
      {children}
    </div>
  );
}

function VirtualRows<T>({
  items,
  rowKey,
  renderItem,
}: {
  items: T[];
  rowKey: (item: T) => string | number;
  renderItem: (item: T) => ReactNode;
}): ReactElement {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportHeight = Math.min(items.length, ACCOUNT_VIEWPORT_ROWS) * ACCOUNT_ROW_HEIGHT;
  const totalHeight = items.length * ACCOUNT_ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ACCOUNT_ROW_HEIGHT) - ACCOUNT_OVERSCAN);
  const visibleCount = ACCOUNT_VIEWPORT_ROWS + ACCOUNT_OVERSCAN * 2;
  const endIndex = Math.min(items.length, startIndex + visibleCount);
  const visibleItems = items.slice(startIndex, endIndex);

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return (
    <div
      className="weq-virtual-rows"
      style={{ maxHeight: viewportHeight }}
      onScroll={onScroll}
    >
      <div className="weq-virtual-spacer" style={{ height: totalHeight }}>
        {visibleItems.map((item, index) => {
          const itemIndex = startIndex + index;
          return (
            <div
              key={rowKey(item)}
              className="weq-virtual-item"
              style={{ top: `${itemIndex * ACCOUNT_ROW_HEIGHT}px` }}
            >
              {renderItem(item)}
            </div>
          );
        })}
      </div>
    </div>
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
      const result = await client.bootstrap.fetchKeyFromInstance.mutate({ pid, dbPath });
      if (!result.success || !result.dbkey) {
        onError(result.error ?? '无法从进程获取密钥');
        return;
      }
      onKey(acc.uin, result.dbkey);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AccountRow
      acc={acc}
      meta={`PID ${pid}`}
      action={
        <ActionButton onClick={() => void go()} disabled={pending} variant="primary">
          {pending ? (
            <Loader2 aria-hidden className="animate-spin" size={15} strokeWidth={1.8} />
          ) : (
            <KeyRound aria-hidden size={15} strokeWidth={1.8} />
          )}
          获取密钥
        </ActionButton>
      }
    />
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
  const [status, setStatus] = useState('待命');

  function go(): void {
    setStatus('正在启动');
    client.bootstrap.quickLogin.subscribe(
      { uin: acc.uin },
      {
        onData(event) {
          if (event.kind === 'login-list') {
            setStatus(`读取到 ${event.list.length} 个账号`);
          } else if (event.kind === 'result') {
            if (event.result.success && event.result.dbkey) {
              onKey(acc.uin, event.result.dbkey);
            } else {
              onError(event.result.error ?? '快速登录失败');
            }
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
    <AccountRow
      acc={acc}
      meta={status === '待命' ? '' : status}
      action={
        <ActionButton onClick={go} disabled={status !== '待命'} variant="soft">
          <ArrowRight aria-hidden size={15} strokeWidth={1.8} />
          快速登录
        </ActionButton>
      }
    />
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
  const [status, setStatus] = useState('待命');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [uin, setUin] = useState(acc?.uin ?? '');
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  useEffect(() => {
    return () => {
      subscriptionRef.current?.unsubscribe();
      subscriptionRef.current = null;
    };
  }, []);

  function closeQr(): void {
    subscriptionRef.current?.unsubscribe();
    subscriptionRef.current = null;
    setStatus('待命');
    setQrUrl(null);
  }

  function go(): void {
    const targetUin = acc?.uin ?? uin.trim();
    if (!targetUin) {
      onError('扫码前请输入该账号的 UIN');
      return;
    }

    subscriptionRef.current?.unsubscribe();
    setStatus('获取二维码');
    setQrUrl(null);
    subscriptionRef.current = client.bootstrap.qrLogin.subscribe(undefined, {
      onData(event) {
        if (event.kind === 'qrcode') {
          setQrUrl(event.url);
          setStatus('请扫描二维码');
        } else if (event.kind === 'qrcode-state') {
          setStatus(formatQrState(event.state));
        } else if (event.kind === 'result') {
          if (event.result.success && event.result.dbkey) {
            onKey(targetUin, event.result.dbkey);
          } else {
            onError(event.result.error ?? '扫码登录失败');
          }
          closeQr();
        }
      },
      onError(e) {
        onError(e instanceof Error ? e.message : String(e));
        closeQr();
      },
    });
  }

  return (
    <>
      <AccountRow
        acc={acc}
        meta={status === '待命' ? '' : status}
        manual={
          acc === null ? (
            <input
              placeholder="账号 UIN"
              value={uin}
              onChange={(e) => setUin(e.target.value)}
              className="weq-input w-32"
            />
          ) : null
        }
        action={
          <ActionButton
            onClick={go}
            disabled={status !== '待命' && status !== '请扫描二维码'}
            variant="soft"
          >
            <QrCode aria-hidden size={15} strokeWidth={1.8} />
            扫码
          </ActionButton>
        }
      />
      {status !== '待命' && (
        <QrLoginDialog
          account={toQrDialogAccount(acc, uin.trim())}
          status={status}
          qrUrl={qrUrl}
          onClose={closeQr}
        />
      )}
    </>
  );
}

function QrLoginDialog({
  account,
  status,
  qrUrl,
  onClose,
}: {
  account: QrDialogAccount;
  status: string;
  qrUrl: string | null;
  onClose: () => void;
}): ReactElement | null {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="weq-dialog-layer" onMouseDown={onClose}>
      <div
        className="weq-qr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weq-qr-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="weq-qr-dialog-head">
          <div>
            <p className="text-[13px] font-medium text-[#0099ff]">扫码登录</p>
            <h3
              id="weq-qr-dialog-title"
              className="weq-display mt-1 text-[21px] font-normal leading-tight text-[#0f2d4c]"
            >
              QQ 安全验证
            </h3>
          </div>
          <button
            onClick={onClose}
            className="weq-icon-button"
            title="关闭"
            aria-label="关闭扫码弹窗"
          >
            <X aria-hidden size={17} strokeWidth={1.8} />
          </button>
        </header>
        <div className="weq-qr-dialog-body">
          <div className="weq-qr-frame">
            {qrUrl ? (
              <QrImage url={qrUrl} size={154} />
            ) : (
              <Loader2
                aria-label="正在获取二维码"
                className="animate-spin text-[#0099ff]"
                size={28}
                strokeWidth={1.7}
              />
            )}
          </div>
          <div className="weq-qr-profile">
            <QrAvatar avatarUrl={account.avatarUrl} name={account.name} />
            <div className="weq-qr-profile-main">
              <div className="weq-qr-profile-top">
                <div className="weq-qr-name">{account.name}</div>
                <div className="weq-qr-status">{status}</div>
              </div>
              <div className="weq-qr-identity">
                <span className="weq-number">{account.qqNumber}</span>
                <span>{account.identityHint}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function QrAvatar({
  avatarUrl,
  name,
}: {
  avatarUrl: string | null;
  name: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);

  if (!avatarUrl || failed) {
    return (
      <span className="weq-qr-avatar-fallback" aria-label={`${name} 的头像`}>
        <UserRound aria-hidden size={20} strokeWidth={1.75} />
      </span>
    );
  }

  return (
    <img
      src={avatarUrl}
      alt={`${name} 的头像`}
      width={44}
      height={44}
      className="weq-qr-avatar"
      onError={() => setFailed(true)}
    />
  );
}

function ManualEntry({ onKey }: { onKey: (uin: string, key: string) => void }): ReactElement {
  const [uin, setUin] = useState('');
  const [key, setKey] = useState('');

  return (
    <div className="grid grid-cols-[8rem_minmax(12rem,1fr)_auto] items-center gap-2">
      <input
        placeholder="账号 UIN"
        value={uin}
        onChange={(e) => setUin(e.target.value)}
        className="weq-input"
      />
      <input
        placeholder="数据库密钥 dbkey"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className="weq-input font-mono"
      />
      <ActionButton onClick={() => onKey(uin, key)} disabled={!uin || !key} variant="primary">
        <ShieldCheck aria-hidden size={15} strokeWidth={1.8} />
        打开
      </ActionButton>
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
  const [deleting, setDeleting] = useState(false);

  async function remove(): Promise<void> {
    if (!confirm(`确定要删除账号 ${cfg.uin} 的配置吗？`)) return;
    setDeleting(true);
    try {
      await deleteConfig.mutateAsync({ uin: cfg.uin });
      onDelete();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AccountRow
      acc={cfg}
      meta={formatTime(cfg.lastLoginAt)}
      action={
        <div className="flex items-center gap-2">
          <ActionButton onClick={() => onKey(cfg.uin, cfg.dbKey)} variant="primary">
            <Check aria-hidden size={15} strokeWidth={1.8} />
            打开
          </ActionButton>
          <button
            onClick={() => void remove()}
            disabled={deleting}
            className="weq-danger-button"
            title="删除配置"
            aria-label="删除配置"
          >
            {deleting ? (
              <Loader2 aria-hidden className="animate-spin" size={15} strokeWidth={1.8} />
            ) : (
              <Trash2 aria-hidden size={15} strokeWidth={1.8} />
            )}
          </button>
        </div>
      }
    />
  );
}

function AccountRow({
  acc,
  meta,
  manual,
  action,
}: {
  acc: LoginAccount | AccountConfig | null;
  meta: string;
  manual?: ReactNode;
  action: ReactNode;
}): ReactElement {
  const uin = acc?.uin;
  const name =
    acc && 'userName' in acc
      ? (acc.userName || acc.uin)
      : acc
        ? (acc.displayName ?? acc.uin)
        : '手动账号';

  return (
    <div className="weq-account-row">
      {acc ? (
        <img
          src={`https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0`}
          alt=""
          width={34}
          height={34}
          className="h-[34px] w-[34px] rounded-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).classList.add('hidden');
          }}
        />
      ) : (
        <span className="weq-avatar-fallback">
          <UserRound aria-hidden size={17} strokeWidth={1.8} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-[#132d48]">{name}</div>
        <div className="mt-0.5 truncate text-[12px] text-[#52677b]">
          {uin ? `UIN ${uin}` : '等待输入 UIN'}
          {meta ? ` · ${meta}` : ''}
        </div>
      </div>
      {manual}
      {action}
    </div>
  );
}

function toQrDialogAccount(acc: LoginAccount | null, fallbackUin: string): QrDialogAccount {
  const qqNumber = acc?.uin || fallbackUin || '等待输入';
  const name = acc?.userName?.trim() || (qqNumber !== '等待输入' ? `QQ ${qqNumber}` : '手动账号');
  const identityHint = acc?.uid?.trim() && acc.uid !== qqNumber
    ? `UID ${acc.uid}`
    : acc
      ? '来自本机登录记录'
      : '手动输入账号';
  const avatarUrl = acc?.avatarUrl?.trim() || (qqNumber !== '等待输入' ? qqAvatarUrl(qqNumber) : null);

  return {
    name,
    qqNumber,
    identityHint,
    avatarUrl,
  };
}

function qqAvatarUrl(uin: string): string {
  return `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0`;
}

function ActionButton({
  children,
  onClick,
  disabled,
  variant,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant: 'primary' | 'soft';
}): ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={variant === 'primary' ? 'weq-action-primary' : 'weq-action-soft'}
    >
      {children}
    </button>
  );
}

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
    <section className="weq-system-section">
      <SectionTitle
        icon={<FolderOpen size={17} strokeWidth={1.75} aria-hidden />}
        title="数据存放目录"
      />
      <div className="weq-root-control">
        <PathLine value={effective ?? '未发现，请手动选择'} />
        {userRoot && (
          <button onClick={() => setUserRoot(null)} className="weq-action-soft shrink-0">
            重置
          </button>
        )}
        <button onClick={() => void browse()} className="weq-action-soft shrink-0">
          更改
        </button>
      </div>
    </section>
  );
}

async function derivePath(uin: string, userRoot: string | null): Promise<string> {
  if (userRoot) {
    return `${userRoot}\\${uin}\\nt_qq\\nt_db\\nt_msg.db`;
  }

  const install = await client.bootstrap.describeInstall.query();
  for (const root of install.tencentFilesRoots) {
    return `${root}\\${uin}\\nt_qq\\nt_db\\nt_msg.db`;
  }

  throw new Error('未发现 Tencent Files 目录，请先手动选择。');
}

function formatQrState(state: string): string {
  if (state === 'waiting') return '等待扫描';
  if (state === 'scanned') return '已扫描';
  if (state === 'confirmed') return '已确认';
  return state;
}

function formatTime(value: number): string {
  if (!value) return '未记录时间';
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
