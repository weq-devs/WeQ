/**
 * 妙妙工具 —— 主窗口「更多功能 → 妙妙工具」弹窗。
 *
 * 布局：左侧工具列表 + 右侧工具界面。工具列表：
 *
 * 「密钥扫描」：
 *   - 后端遍历 login.db 的全部历史账号，逐个反查 `nt_msg.db` 目录与在线
 *     QQ 进程 pid（win32 走 Restart Manager、linux 走 fcntl 写锁，由
 *     platform.resolveQqPid 统一封装）。
 *   - 在线账号卡片亮起（绿色在线点 + 高亮），离线账号置灰。
 *   - 点击卡片 → 卡片加载动画 → 对账号进程做零注入内存扫描
 *     （nt_helper scanKeyFromDatabase），展示恢复的密钥、密钥所在内存的
 *     上下文 hexdump（高亮密钥字节）或失败原因。
 *
 * 「其它设备密钥」：
 *   - 先检查是否有可用的在线 QQ 实例（复用密钥扫描的 pid 判定），没有就
 *     把「获取密钥」按钮置灰。
 *   - 选择其它设备导出的 `nt_msg.db` → 读取头部字节（256B）展示 hexdump，
 *     高亮发包用的 db_salt（文件偏移 0x2f..0xaf，与 nt_helper
 *     request_decrypt_key 一致）。
 *   - hexdump 下方显示加载动画，然后按 bootstrap 的实例取密钥流程（跳过
 *     注入，直接调 nt_helper requestDecryptKey）返回密钥或失败原因。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Binary,
  Braces,
  Check,
  Copy,
  Database,
  FolderOpen,
  KeyRound,
  Loader2,
  RefreshCw,
  ScanSearch,
  X,
} from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { closeFromScrim } from '../im-template/template/modalUtils';
import { ReverseTool } from './ReverseTool';

interface AccountRow {
  uin: string;
  uid: string;
  userName: string;
  avatarUrl: string;
  lastLoginAt: number;
  dbPath: string | null;
  pid: number | null;
}

interface ScanResultWire {
  success: boolean;
  key?: string;
  keyContextHex?: string;
  error?: string;
}

interface ScanResultView extends ScanResultWire {
  uin: string;
  name: string;
  pid: number | null;
}

type ToolId = 'key-scan' | 'other-device-key' | 'reverse';

const TOOLS: { id: ToolId; label: string; desc: string }[] = [
  { id: 'key-scan', label: '密钥扫描', desc: '零注入内存扫描主密钥' },
  { id: 'other-device-key', label: '其它设备密钥', desc: '获取账号其它设备的密钥' },
  { id: 'reverse', label: 'Protobuf/JCE 逆向', desc: 'hex/base64 → 简洁 JSON' },
];

const TOOL_ICONS: Record<ToolId, typeof KeyRound> = {
  'key-scan': KeyRound,
  'other-device-key': Database,
  reverse: Braces,
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function humanTime(sec: number): string {
  if (!sec) return '从未登录';
  try {
    return new Date(sec * 1000).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(sec);
  }
}

/** 每行渲染的字节数（经典 hexdump 宽度）。 */
const HEX_ROW = 16;
/** 密钥字节数（SQLCipher raw_key 长度）。 */
const KEY_BYTES = 16;

interface HexRow {
  base: number;
  bytes: number[];
}

function parseHexBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-f]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 2 <= clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function buildHexRows(bytes: number[]): HexRow[] {
  const rows: HexRow[] = [];
  for (let i = 0; i < bytes.length; i += HEX_ROW) {
    rows.push({ base: i, bytes: bytes.slice(i, i + HEX_ROW) });
  }
  return rows;
}

function isPrintableByte(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

/**
 * 通用 hexdump：偏移 + 十六进制 + ASCII，`[hlStart, hlEnd)` 区间字节高亮。
 * 供密钥内存上下文与其它设备数据库头共用。
 */
function HexDumpView({
  title,
  legend,
  hex,
  hlStart,
  hlEnd,
}: {
  title: ReactElement | string;
  legend: ReactElement | string;
  hex: string;
  /** 高亮起始字节偏移（含）；-1 表示不高亮。 */
  hlStart: number;
  /** 高亮结束字节偏移（不含）。 */
  hlEnd: number;
}): ReactElement | null {
  const rows = useMemo(() => buildHexRows(parseHexBytes(hex)), [hex]);
  if (rows.length === 0) return null;
  const highlightActive = hlStart >= 0 && hlEnd > hlStart;
  return (
    <div className="weq-wtools-hexdump">
      <div className="weq-wtools-hexdump-head">
        <span className="weq-wtools-hexdump-title">{title}</span>
        <span className="weq-wtools-hexdump-legend">{legend}</span>
      </div>
      <div className="weq-wtools-hexdump-scroll">
        {rows.map((row, ri) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
          <div className="weq-wtools-hexline" key={ri}>
            <span className="weq-wtools-hex-offset">{row.base.toString(16).padStart(8, '0')}</span>
            <span className="weq-wtools-hex-bytes">
              {row.bytes.map((b, ci) => {
                const idx = row.base + ci;
                const isHl = highlightActive && idx >= hlStart && idx < hlEnd;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                  <span key={ci} className={`weq-wtools-hex-byte${isHl ? ' is-key' : ''}`}>
                    {b.toString(16).padStart(2, '0')}
                  </span>
                );
              })}
            </span>
            <span className="weq-wtools-hex-ascii">
              {row.bytes.map((b, ci) => {
                const idx = row.base + ci;
                const isHl = highlightActive && idx >= hlStart && idx < hlEnd;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                  <span key={ci} className={`weq-wtools-hex-ch${isHl ? ' is-key' : ''}`}>
                    {isPrintableByte(b) ? String.fromCharCode(b) : '.'}
                  </span>
                );
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 把 ASCII 密钥逐字节转成小写 hex，用于在上下文中定位密钥。 */
function asciiToHex(key: string): string {
  let out = '';
  for (let i = 0; i < key.length; i++) {
    out += key.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return out;
}

/** 密钥内存上下文 hexdump：前 256B + 后 256B，密钥字节高亮。 */
function KeyContextDump({
  contextHex,
  keyText,
}: {
  contextHex: string;
  keyText: string;
}): ReactElement | null {
  const keyStart = useMemo(
    () => contextHex.indexOf(asciiToHex(keyText)) / 2,
    [contextHex, keyText],
  );
  const found = keyStart >= 0 && Number.isInteger(keyStart);
  if (parseHexBytes(contextHex).length === 0) return null;
  return (
    <HexDumpView
      title={
        <>
          <Binary size={13} strokeWidth={1.9} />
          密钥内存上下文
        </>
      }
      legend={
        <>
          前 256B + 后 256B · <b>高亮</b> = 密钥
        </>
      }
      hex={contextHex}
      hlStart={found ? keyStart : -1}
      hlEnd={found ? keyStart + KEY_BYTES : -1}
    />
  );
}

/** 其它设备数据库头部 hexdump：高亮发包用的 db_salt 区间。 */
function SaltHeaderDump({
  hex,
  saltStart,
  saltEnd,
}: {
  hex: string;
  saltStart: number;
  saltEnd: number;
}): ReactElement {
  return (
    <HexDumpView
      title={
        <>
          <Database size={13} strokeWidth={1.9} />
          数据库头部（前 {hex.length / 2} 字节）
        </>
      }
      legend={
        <>
          偏移 0x{saltStart.toString(16)}–0x{(saltEnd - 1).toString(16)} · <b>高亮</b> =
          key_meta（发包内容）
        </>
      }
      hex={hex}
      hlStart={saltStart}
      hlEnd={saltEnd}
    />
  );
}

export function WonderfulToolsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  const [activeTool, setActiveTool] = useState<ToolId>('key-scan');
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 全局「自动注入 QQ（完整功能）」——关闭即完全离线模式。 */
  const [autoInjectQq, setAutoInjectQq] = useState(true);
  const [scanningUin, setScanningUin] = useState<string | null>(null);
  /** 正在扫描 / 已出结果的账号 —— 存在时弹出结果模态窗口。 */
  const [scanTarget, setScanTarget] = useState<AccountRow | null>(null);
  const [result, setResult] = useState<ScanResultView | null>(null);
  const [copied, setCopied] = useState(false);

  // —— 其它设备密钥 ——
  const [otherDbPath, setOtherDbPath] = useState<string | null>(null);
  const [headerHex, setHeaderHex] = useState<string | null>(null);
  const [saltInfo, setSaltInfo] = useState<{
    dbSalt: string;
    saltValid: boolean;
    saltStart: number;
    saltEnd: number;
  } | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [headerLoading, setHeaderLoading] = useState(false);
  const [fetchingKey, setFetchingKey] = useState(false);
  const [otherResult, setOtherResult] = useState<{
    success: boolean;
    key?: string;
    pid?: number;
    error?: string;
  } | null>(null);
  const [otherCopied, setOtherCopied] = useState(false);

  /** 当前在线的 QQ 实例数（密钥扫描用：零注入，离线模式下仍可用）。 */
  const onlineCount = accounts.filter((a) => a.pid !== null).length;
  /** 其它设备密钥需要「已注入」的在线实例；完全离线模式下视为 0。 */
  const otherKeyOnline = autoInjectQq ? onlineCount : 0;

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    void client.bootstrap.getSettings
      .query()
      .then((s) => {
        if (alive) setAutoInjectQq(s.autoInjectQq);
      })
      .catch(() => {
        /* 读不到就按默认开启处理 */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const closeResult = useCallback(() => {
    setScanTarget(null);
    setScanningUin(null);
    setResult(null);
    setCopied(false);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (scanTarget) {
        closeResult();
      } else {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, scanTarget, closeResult, onClose]);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await client.wonderfulTools.overview.query();
      setAccounts(rows);
      // 账号列表刷新后，旧扫描结果不再可靠。
      setResult(null);
      setScanTarget(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setResult(null);
      setScanningUin(null);
      setScanTarget(null);
      setOtherDbPath(null);
      setHeaderHex(null);
      setSaltInfo(null);
      setHeaderError(null);
      setHeaderLoading(false);
      setFetchingKey(false);
      setOtherResult(null);
      setOtherCopied(false);
      void loadAccounts();
    }
  }, [open, loadAccounts]);

  async function scanAccount(acc: AccountRow): Promise<void> {
    setScanTarget(acc);
    setScanningUin(acc.uin);
    setResult(null);
    try {
      const r = await client.wonderfulTools.scanKey.query({ uin: acc.uin });
      setResult({ ...r, uin: acc.uin, name: acc.userName || acc.uin, pid: acc.pid });
    } catch (e) {
      setResult({
        success: false,
        error: errMsg(e),
        uin: acc.uin,
        name: acc.userName || acc.uin,
        pid: acc.pid,
      });
    } finally {
      setScanningUin(null);
    }
  }

  function copyKey(): void {
    if (!result?.key) return;
    void navigator.clipboard.writeText(result.key).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  async function pickOtherDb(): Promise<void> {
    if (fetchingKey) return;
    try {
      const picked = await client.wonderfulTools.pickDatabase.mutate();
      if (!picked) return;
      setOtherDbPath(picked);
      setHeaderHex(null);
      setSaltInfo(null);
      setHeaderError(null);
      setOtherResult(null);
      setHeaderLoading(true);
      try {
        const peek = await client.wonderfulTools.peekDatabaseHeader.query({ dbPath: picked });
        if (peek.ok) {
          setHeaderHex(peek.hex);
          setSaltInfo({
            dbSalt: peek.dbSalt,
            saltValid: peek.saltValid,
            saltStart: peek.saltStart,
            saltEnd: peek.saltEnd,
          });
        } else {
          setHeaderError(peek.error);
        }
      } catch (e) {
        setHeaderError(errMsg(e));
      } finally {
        setHeaderLoading(false);
      }
    } catch (e) {
      setHeaderError(errMsg(e));
    }
  }

  async function fetchOtherKey(): Promise<void> {
    if (!otherDbPath || onlineCount === 0 || fetchingKey) return;
    setFetchingKey(true);
    setOtherResult(null);
    try {
      const r = await client.wonderfulTools.fetchOtherDeviceKey.mutate({ dbPath: otherDbPath });
      setOtherResult(r);
    } catch (e) {
      setOtherResult({ success: false, error: errMsg(e) });
    } finally {
      setFetchingKey(false);
    }
  }

  function copyOtherKey(): void {
    if (!otherResult?.key) return;
    void navigator.clipboard.writeText(otherResult.key).then(() => {
      setOtherCopied(true);
      window.setTimeout(() => setOtherCopied(false), 1400);
    });
  }

  if (!open) return null;

  return (
    <div className="weq-wtools-layer" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <div
        className="weq-wtools-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weq-wtools-title"
      >
        <button className="weq-wtools-close" onClick={onClose} title="关闭" type="button">
          <X size={18} strokeWidth={2} />
        </button>

        <div className="weq-wtools-shell">
          {/* 左栏：工具列表 */}
          <aside className="weq-wtools-nav">
            <div className="weq-wtools-brand">
              <span className="weq-wtools-brand-icon">
                <ScanSearch size={17} strokeWidth={1.8} />
              </span>
              <span>妙妙工具</span>
            </div>
            <div className="weq-wtools-nav-list" role="tablist" aria-label="工具列表">
              {TOOLS.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTool === tool.id}
                  className={`weq-wtools-nav-item${activeTool === tool.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setActiveTool(tool.id);
                    setResult(null);
                    setScanningUin(null);
                    setScanTarget(null);
                  }}
                >
                  {(() => {
                    const ToolIcon = TOOL_ICONS[tool.id];
                    return <ToolIcon size={16} strokeWidth={1.8} />;
                  })()}
                  <span>
                    <strong>{tool.label}</strong>
                    <em>{tool.desc}</em>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {/* 右栏：工具界面 */}
          <section className="weq-wtools-pane">
            {activeTool === 'key-scan' ? (
              <>
                <header className="weq-wtools-pane-head">
                  <div className="weq-wtools-pane-title">
                    <KeyRound size={17} strokeWidth={1.9} />
                    <h2 id="weq-wtools-title">密钥扫描</h2>
                    {!loading && accounts.length > 0 ? (
                      <span className="weq-wtools-total">
                        {onlineCount} / {accounts.length} 在线
                      </span>
                    ) : null}
                  </div>
                </header>

                <div className="weq-wtools-pane-body">
                  {loading ? (
                    <div className="weq-wtools-state">
                      <Loader2 size={22} className="weq-spin" />
                      <span>正在读取账号与在线状态…</span>
                    </div>
                  ) : error ? (
                    <div className="weq-wtools-state is-error">{error}</div>
                  ) : accounts.length === 0 ? (
                    <div className="weq-wtools-state">
                      未在 login.db 中发现历史账号，请先在 QQ / WeQ 登录过账号。
                    </div>
                  ) : (
                    <>
                      <div className="weq-wtools-toolbar">
                        <button
                          type="button"
                          className="weq-wtools-refresh"
                          onClick={() => void loadAccounts()}
                          disabled={loading}
                        >
                          <RefreshCw
                            size={14}
                            strokeWidth={1.9}
                            className={loading ? 'weq-spin' : ''}
                          />
                          刷新
                        </button>
                      </div>
                      <div className="weq-wtools-grid">
                        {accounts.map((acc) => {
                          const online = acc.pid !== null;
                          const busy = scanningUin === acc.uin;
                          return (
                            <button
                              key={acc.uin}
                              type="button"
                              className={`weq-wtools-card${online ? ' is-online' : ' is-offline'}${busy ? ' is-busy' : ''}`}
                              onClick={() => void scanAccount(acc)}
                              disabled={busy}
                              title={
                                online
                                  ? `在线 · PID ${acc.pid} · 上次登录 ${humanTime(acc.lastLoginAt)}，点击扫描密钥`
                                  : `离线账号 · 上次登录 ${humanTime(acc.lastLoginAt)}，点击尝试扫描`
                              }
                            >
                              <span className="weq-wtools-card-avatar">
                                <QqAvatar uin={acc.uin} url={acc.avatarUrl} size={44} />
                                <i className="weq-wtools-card-dot" aria-hidden />
                              </span>
                              <span className="weq-wtools-card-id">
                                <strong>{acc.userName || acc.uin}</strong>
                                <em>{acc.uin}</em>
                              </span>
                              <span className="weq-wtools-card-status">
                                {busy ? (
                                  <Loader2 size={13} className="weq-spin" aria-label="扫描中" />
                                ) : online ? (
                                  <span className="is-online-text">在线</span>
                                ) : (
                                  <span className="is-offline-text">离线</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : null}

            {activeTool === 'other-device-key' ? (
              <>
                <header className="weq-wtools-pane-head">
                  <div className="weq-wtools-pane-title">
                    <Database size={17} strokeWidth={1.9} />
                    <h2 id="weq-wtools-title">其它设备密钥</h2>
                    <span
                      className={`weq-wtools-online-badge${otherKeyOnline > 0 ? ' is-online' : ''}`}
                    >
                      {autoInjectQq
                        ? otherKeyOnline > 0
                          ? `${otherKeyOnline} 个在线实例可用`
                          : '无在线实例'
                        : '完全离线模式'}
                    </span>
                  </div>
                  <div className="weq-wtools-toolbar">
                    {/*<button*/}
                    {/*  type="button"*/}
                    {/*  className="weq-wtools-refresh"*/}
                    {/*  onClick={() => void loadAccounts()}*/}
                    {/*  disabled={loading}*/}
                    {/*>*/}
                    {/*  <RefreshCw*/}
                    {/*    size={14}*/}
                    {/*    strokeWidth={1.9}*/}
                    {/*    className={loading ? 'weq-spin' : ''}*/}
                    {/*  />*/}
                    {/*  刷新在线*/}
                    {/*</button>*/}
                  </div>
                </header>

                <div className="weq-wtools-pane-body">
                  {/* 选择数据库 */}
                  <div className="weq-wtools-odev-pick">
                    <button
                      type="button"
                      className="weq-wtools-pick"
                      onClick={() => void pickOtherDb()}
                      disabled={fetchingKey}
                      title="选择其它设备导出的 nt_msg.db"
                    >
                      <FolderOpen size={15} strokeWidth={1.9} />
                      选择数据库
                    </button>
                    <span
                      className={`weq-wtools-odev-path${otherDbPath ? ' is-picked' : ''}`}
                      title={otherDbPath ?? undefined}
                    >
                      {otherDbPath ?? '请选择其它设备导出的 nt_msg.db'}
                    </span>
                  </div>

                  {/* 数据库头部 hexdump（高亮 db_salt） */}
                  {headerLoading ? (
                    <div className="weq-wtools-state weq-wtools-odev-state">
                      <Loader2 size={20} className="weq-spin" />
                      <span>正在读取数据库头部…</span>
                    </div>
                  ) : headerError ? (
                    <div className="weq-wtools-state is-error weq-wtools-odev-state">
                      {headerError}
                    </div>
                  ) : headerHex && saltInfo ? (
                    <div className="weq-wtools-odev-dump">
                      <SaltHeaderDump
                        hex={headerHex}
                        saltStart={saltInfo.saltStart}
                        saltEnd={saltInfo.saltEnd}
                      />
                      <div
                        className={`weq-wtools-odev-salt${saltInfo.saltValid ? ' is-valid' : ' is-invalid'}`}
                      >
                        <span className="weq-wtools-odev-salt-label">key_meta</span>
                        <code>
                          {saltInfo.dbSalt.length > 64
                            ? `${saltInfo.dbSalt.slice(0, 64)}…`
                            : saltInfo.dbSalt || '（空）'}
                        </code>
                        <span className="weq-wtools-odev-salt-badge">
                          {saltInfo.saltValid ? '有效' : '无效'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="weq-wtools-odev-placeholder">
                      <Database size={22} strokeWidth={1.6} />
                      <span>选择数据库后在此显示头部 hexdump</span>
                    </div>
                  )}

                  {/* 获取密钥 */}
                  <div className="weq-wtools-odev-actions">
                    <button
                      type="button"
                      className="weq-wtools-fetch"
                      onClick={() => void fetchOtherKey()}
                      disabled={
                        !otherDbPath || otherKeyOnline === 0 || fetchingKey || headerLoading
                      }
                      title={
                        !autoInjectQq
                          ? '已开启完全离线模式，无法向 QQ 请求密钥'
                          : otherKeyOnline === 0
                            ? '没有可用的在线 QQ 实例，无法发包获取密钥'
                            : '按 bootstrap 取密钥流程，向在线 QQ 请求该数据库的密钥'
                      }
                    >
                      {fetchingKey ? (
                        <Loader2 size={15} className="weq-spin" />
                      ) : (
                        <KeyRound size={15} strokeWidth={1.9} />
                      )}
                      {fetchingKey ? '正在获取…' : '获取密钥'}
                    </button>
                    {otherKeyOnline === 0 && !fetchingKey ? (
                      <span className="weq-wtools-odev-hint">
                        {autoInjectQq
                          ? '无在线实例，按钮保持灰色：请先登录 QQ 并保持在线'
                          : '已开启完全离线模式（自动注入 QQ 已关闭），无法向 QQ 请求密钥'}
                      </span>
                    ) : null}
                  </div>

                  {/* hexdump 下方：加载动画 → 密钥 / 失败原因 */}
                  {fetchingKey ? (
                    <div className="weq-wtools-odev-fetching">
                      <Loader2 size={18} className="weq-spin" />
                      <span>正在通过在线 QQ 请求密钥（OIDB 0xcde_2）…</span>
                    </div>
                  ) : otherResult ? (
                    otherResult.success && otherResult.key ? (
                      <div className="weq-wtools-odev-result">
                        {/*<span className="weq-wtools-result-ok-badge">获取成功</span>*/}
                        <div className="weq-wtools-key-row">
                          <code>{otherResult.key}</code>
                          <button
                            type="button"
                            className="weq-wtools-copy"
                            onClick={copyOtherKey}
                            title="复制密钥"
                          >
                            {otherCopied ? <Check size={15} /> : <Copy size={15} />}
                            {otherCopied ? '已复制' : '复制'}
                          </button>
                        </div>
                        {otherResult.pid ? (
                          <span className="weq-wtools-odev-pid">
                            由在线实例 PID {otherResult.pid} 返回
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="weq-wtools-odev-result is-error">
                        <span className="weq-wtools-result-err-badge">获取失败</span>
                        <p>{otherResult.error ?? '未知错误'}</p>
                      </div>
                    )
                  ) : null}
                </div>
              </>
            ) : null}

            {activeTool === 'reverse' ? (
              <>
                <header className="weq-wtools-pane-head">
                  <div className="weq-wtools-pane-title">
                    <Braces size={17} strokeWidth={1.9} />
                    <h2 id="weq-wtools-title">Protobuf / JCE 逆向</h2>
                  </div>
                </header>
                <div className="weq-wtools-pane-body">
                  <ReverseTool />
                </div>
              </>
            ) : null}
          </section>
        </div>
      </div>

      {/* 扫描结果模态窗口：头像 / 昵称 / QQ 号 / PID + 密钥（复制） */}
      {scanTarget ? (
        <div
          className="weq-wtools-result-layer"
          role="presentation"
          onMouseDown={closeFromScrim(closeResult)}
        >
          <section
            className="weq-wtools-result-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="weq-wtools-result-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="weq-wtools-result-close"
              type="button"
              title="关闭"
              aria-label="关闭"
              onClick={closeResult}
            >
              <X size={16} strokeWidth={2} />
            </button>
            <div className="weq-wtools-result-avatar">
              <QqAvatar
                uin={scanTarget.uin}
                url={scanTarget.avatarUrl}
                size={64}
                className="weq-wtools-result-avatar-img"
              />
            </div>
            <strong id="weq-wtools-result-title" className="weq-wtools-result-name">
              {scanTarget.userName || scanTarget.uin}
            </strong>
            <span className="weq-wtools-result-uin">QQ 号 {scanTarget.uin}</span>
            {scanTarget.pid ? (
              <span className="weq-wtools-result-pid">PID {scanTarget.pid}</span>
            ) : null}

            <div className="weq-wtools-result-body">
              {scanningUin ? (
                <div className="weq-wtools-state">
                  <Loader2 size={20} className="weq-spin" />
                  <span>正在扫描进程内存并验证密钥…</span>
                </div>
              ) : result ? (
                result.success && result.key ? (
                  <>
                    <span className="weq-wtools-result-ok-badge">扫描成功</span>
                    <div className="weq-wtools-key-row">
                      <code>{result.key}</code>
                      <button
                        type="button"
                        className="weq-wtools-copy"
                        onClick={copyKey}
                        title="复制密钥"
                      >
                        {copied ? <Check size={15} /> : <Copy size={15} />}
                        {copied ? '已复制' : '复制'}
                      </button>
                    </div>
                    {result.keyContextHex ? (
                      <KeyContextDump contextHex={result.keyContextHex} keyText={result.key} />
                    ) : null}
                  </>
                ) : (
                  <div className="weq-wtools-result-err">
                    <span className="weq-wtools-result-err-badge">扫描未成功</span>
                    <p>{result.error ?? '未知错误'}</p>
                  </div>
                )
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
