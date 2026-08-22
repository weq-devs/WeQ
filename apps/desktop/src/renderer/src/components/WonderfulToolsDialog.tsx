/**
 * 妙妙工具 —— 主窗口「更多功能 → 妙妙工具」弹窗。
 *
 * 布局：左侧工具列表 + 右侧工具界面。第一个工具是「密钥扫描」：
 *   - 后端遍历 login.db 的全部历史账号，逐个反查 `nt_msg.db` 目录与在线
 *     QQ 进程 pid（win32 走 Restart Manager、linux 走 fcntl 写锁，由
 *     platform.resolveQqPid 统一封装）。
 *   - 在线账号卡片亮起（绿色在线点 + 高亮），离线账号置灰。
 *   - 点击卡片 → 卡片加载动画 → 对账号进程做零注入内存扫描
 *     （nt_helper scanKeyFromDatabase），展示恢复的密钥、密钥所在内存的
 *     上下文 hexdump（高亮密钥字节）或失败原因。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Binary, Check, Copy, KeyRound, Loader2, RefreshCw, ScanSearch, X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { closeFromScrim } from '../im-template/template/modalUtils';

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

type ToolId = 'key-scan';

const TOOLS: { id: ToolId; label: string; desc: string }[] = [
  { id: 'key-scan', label: '密钥扫描', desc: '零注入内存扫描主密钥' },
];

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

interface HexDump {
  rows: HexRow[];
  /** 密钥在窗口内的起始字节偏移；-1 表示未定位到。 */
  keyStart: number;
}

function parseContextHex(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-f]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 2 <= clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

/** 把 ASCII 密钥逐字节转成小写 hex，用于在上下文中定位密钥。 */
function asciiToHex(key: string): string {
  let out = '';
  for (let i = 0; i < key.length; i++) {
    out += key.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return out;
}

function isPrintableByte(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

function buildHexDump(contextHex: string, key: string): HexDump {
  const bytes = parseContextHex(contextHex);
  const found = contextHex.indexOf(asciiToHex(key));
  const keyStart = found >= 0 ? found / 2 : -1;
  const rows: HexRow[] = [];
  for (let i = 0; i < bytes.length; i += HEX_ROW) {
    rows.push({ base: i, bytes: bytes.slice(i, i + HEX_ROW) });
  }
  return { rows, keyStart };
}

/** 密钥内存上下文 hexdump：偏移 + 十六进制 + ASCII，密钥字节高亮。 */
function KeyContextDump({
  contextHex,
  keyText,
}: {
  contextHex: string;
  keyText: string;
}): ReactElement | null {
  const dump = useMemo(() => buildHexDump(contextHex, keyText), [contextHex, keyText]);
  if (!dump || dump.rows.length === 0) return null;
  const keyActive = dump.keyStart >= 0;
  const keyEnd = keyActive ? dump.keyStart + KEY_BYTES : -1;
  return (
    <div className="weq-wtools-hexdump">
      <div className="weq-wtools-hexdump-head">
        <span className="weq-wtools-hexdump-title">
          <Binary size={13} strokeWidth={1.9} />
          密钥内存上下文
        </span>
        <span className="weq-wtools-hexdump-legend">
          前 256B + 后 256B · <b>高亮</b> = 密钥
        </span>
      </div>
      <div className="weq-wtools-hexdump-scroll">
        {dump.rows.map((row, ri) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
          <div className="weq-wtools-hexline" key={ri}>
            <span className="weq-wtools-hex-offset">
              {row.base.toString(16).padStart(8, '0')}
            </span>
            <span className="weq-wtools-hex-bytes">
              {row.bytes.map((b, ci) => {
                const idx = row.base + ci;
                const inKey = keyActive && idx >= dump.keyStart && idx < keyEnd;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                  <span key={ci} className={`weq-wtools-hex-byte${inKey ? ' is-key' : ''}`}>
                    {b.toString(16).padStart(2, '0')}
                  </span>
                );
              })}
            </span>
            <span className="weq-wtools-hex-ascii">
              {row.bytes.map((b, ci) => {
                const idx = row.base + ci;
                const inKey = keyActive && idx >= dump.keyStart && idx < keyEnd;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                  <span key={ci} className={`weq-wtools-hex-ch${inKey ? ' is-key' : ''}`}>
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
  const [scanningUin, setScanningUin] = useState<string | null>(null);
  /** 正在扫描 / 已出结果的账号 —— 存在时弹出结果模态窗口。 */
  const [scanTarget, setScanTarget] = useState<AccountRow | null>(null);
  const [result, setResult] = useState<ScanResultView | null>(null);
  const [copied, setCopied] = useState(false);

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

  if (!open) return null;

  const onlineCount = accounts.filter((a) => a.pid !== null).length;

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
                  <KeyRound size={16} strokeWidth={1.8} />
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
