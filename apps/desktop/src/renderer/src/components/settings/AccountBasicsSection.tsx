/**
 * 设置 → 账号基础.
 *
 * Everything tied to the open account: self profile, the database key, the live
 * download rkeys, plus the behaviour switches (实时消息 / 媒体补全 / ClientKey
 * 占位). Realtime + media-completion are stored globally but read most naturally
 * here next to the account they affect.
 *
 * Freshness: the QueryClient keeps data fresh 5 min and does NOT refetch on
 * mount by default, which made this panel show stale rkeys/settings after they
 * changed in the background. Every query here opts into `staleTime: 0` +
 * `refetchOnMount: 'always'`; the account config also polls while open so a
 * freshly-harvested rkey appears without reopening. After each settings
 * mutation we refetch so a reopen reflects what was persisted.
 *
 * Avatar: built from the uin (`QqAvatar` → thirdqq CDN), NOT the profile's
 * stored avatarUrl — that URL can be a stale/expired signed link that 502s.
 */

import { useEffect, useState, type ReactElement } from 'react';
import {
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  ImageDown,
  KeyRound,
  RefreshCw,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { QqAvatar } from '../QqAvatar';
import { Card, CheckPill, Row, SectionHeader, Toggle } from './controls';

/** rkey `type_` → human label. Mirrors media_download.ts scene constants. */
const RKEY_TYPE_LABEL: Record<number, string> = {
  10: '私聊图片',
  20: '群聊图片',
  12: '私聊视频',
  22: '群聊视频',
  14: '私聊语音',
  24: '群聊语音',
};

type MediaTypes = {
  image: boolean;
  sticker: boolean;
  videoCover: boolean;
  video: boolean;
  file: boolean;
};

const MEDIA_TYPE_ROWS: Array<{ key: keyof MediaTypes; label: string }> = [
  { key: 'image', label: '图片' },
  { key: 'sticker', label: '表情' },
  { key: 'videoCover', label: '视频封面图' },
  { key: 'video', label: '视频原文件' },
  { key: 'file', label: '文件' },
];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "3 小时 / 12 分钟后过期" or "已过期", from create + ttl (both unix seconds). */
function formatExpiry(createTime: number, ttlSeconds: number): { text: string; expired: boolean } {
  const expiryMs = (createTime + ttlSeconds) * 1000;
  const leftMs = expiryMs - Date.now();
  if (leftMs <= 0) return { text: '已过期', expired: true };
  const mins = Math.floor(leftMs / 60000);
  if (mins < 60) return { text: `${mins} 分钟后过期`, expired: false };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { text: `${hours} 小时后过期`, expired: false };
  return { text: `${Math.floor(hours / 24)} 天后过期`, expired: false };
}

export function AccountBasicsSection(): ReactElement {
  const showError = useDialog((s) => s.showError);

  const profile = trpc.account.getSelfProfile.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
    // rkeys are harvested in the background by the monitor; poll so a fresh one
    // shows up (and the expiry countdown re-renders) without reopening.
    refetchInterval: 10_000,
  });
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const setRealtime = trpc.bootstrap.setRealtimeEnabled.useMutation();
  const setMedia = trpc.bootstrap.setMediaCompletion.useMutation();
  const setClientKey = trpc.bootstrap.setAutoFetchClientKey.useMutation();

  const [revealKey, setRevealKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // Local mirror for snappy toggles; re-seeded whenever server data changes.
  const [realtime, setRealtimeLocal] = useState(true);
  const [mediaEnabled, setMediaEnabled] = useState(true);
  const [forViewing, setForViewing] = useState(true);
  const [forExport, setForExport] = useState(true);
  const [types, setTypes] = useState<MediaTypes>({
    image: true,
    sticker: true,
    videoCover: true,
    video: false,
    file: false,
  });
  const [autoClientKey, setAutoClientKey] = useState(false);

  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    setRealtimeLocal(d.realtimeEnabled);
    setMediaEnabled(d.mediaCompletion.enabled);
    setForViewing(d.mediaCompletion.forViewing);
    setForExport(d.mediaCompletion.forExport);
    setTypes(d.mediaCompletion.types);
    setAutoClientKey(d.autoFetchClientKey);
  }, [settings.data]);

  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const p = profile.data;
  const cfg = config.data;
  const dbKey = cfg?.dbKey ?? '';
  const maskedKey = dbKey ? '•'.repeat(Math.min(dbKey.length, 48)) : '';
  const rkeys = cfg?.rkeys ?? [];
  const settingsLoading = settings.isLoading;

  async function copyText(text: string, onOk?: () => void): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onOk?.();
    } catch (e) {
      showError('复制失败', errMsg(e));
    }
  }

  // Each toggle: flip locally for instant feedback, persist, then refetch so a
  // reopen reflects what's on disk. On failure, reconcile + surface the error.
  async function persist(apply: () => void, mutate: () => Promise<unknown>): Promise<void> {
    apply();
    try {
      await mutate();
      await settings.refetch();
    } catch (e) {
      await settings.refetch();
      showError('保存失败', errMsg(e));
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader title="账号基础" desc="当前账号的资料、密钥，以及实时消息与媒体补全开关。" />

      {/* Self profile hero */}
      <Card>
        {p ? (
          <div className="weq-set-hero">
            {/* uin-built avatar; ignore p.avatarUrl (can be a stale 502 link). */}
            <QqAvatar uin={p.uin} size={56} className="weq-set-hero-avatar" />
            <div className="weq-set-hero-info">
              <span className="weq-set-hero-name">{p.remark || p.nick || p.uin}</span>
              <span className="weq-set-hero-sub weq-number">QQ {p.uin}</span>
              {p.signature ? (
                <span className="weq-set-hero-sig" title={p.signature}>
                  {p.signature}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="weq-set-empty">
            {profile.isLoading ? '加载账号资料中…' : '暂无账号资料'}
          </div>
        )}
      </Card>

      {/* Database key */}
      <Card title="数据库密钥">
        <div className="weq-set-keyfield">
          <KeyRound size={15} strokeWidth={1.8} className="weq-set-keyfield-icon" aria-hidden />
          <code className="weq-set-keyval">
            {dbKey ? (revealKey ? dbKey : maskedKey) : config.isLoading ? '读取中…' : '未获取'}
          </code>
          <div className="weq-set-keyfield-actions">
            <button
              type="button"
              className="weq-set-iconbtn"
              title={revealKey ? '隐藏' : '显示'}
              aria-label={revealKey ? '隐藏密钥' : '显示密钥'}
              disabled={!dbKey}
              onClick={() => setRevealKey((v) => !v)}
            >
              {revealKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="复制"
              aria-label="复制密钥"
              disabled={!dbKey}
              onClick={() => void copyText(dbKey, () => setCopied(true))}
            >
              {copied ? <Check size={15} className="weq-set-ok" /> : <Copy size={15} />}
            </button>
          </div>
        </div>
        {cfg?.algo ? (
          <p className="weq-set-note">
            算法：page {cfg.algo.pageHmacAlgorithm} · kdf {cfg.algo.kdfHmacAlgorithm}
          </p>
        ) : null}
      </Card>

      {/* Download rkeys (show the actual rkey value) */}
      <Card
        title="下载 rKey"
        action={
          <button
            type="button"
            className={`weq-set-iconbtn${config.isFetching ? ' is-spinning' : ''}`}
            title="刷新"
            aria-label="刷新 rKey"
            onClick={() => void config.refetch()}
          >
            <RefreshCw size={14} />
          </button>
        }
      >
        {rkeys.length === 0 ? (
          <div className="weq-set-empty">
            {config.isLoading
              ? '读取中…'
              : cfg?.qqOnline
                ? '在线实例已连接，正在等待获取 rKey…'
                : '未获取到 rKey（需要登录中的 QQ 在线，且开启「媒体补全」）。'}
          </div>
        ) : (
          <ul className="weq-set-rkey-list">
            {rkeys.map((r, i) => {
              const exp = formatExpiry(r.createTime, r.ttlSeconds);
              return (
                <li key={`${r.type}-${i}`} className="weq-set-rkey-item">
                  <div className="weq-set-rkey-head">
                    <span className="weq-set-rkey-type">
                      {RKEY_TYPE_LABEL[r.type] ?? `类型 ${r.type}`}
                    </span>
                    <span className={`weq-set-rkey-exp${exp.expired ? ' is-expired' : ''}`}>
                      {exp.text}
                    </span>
                    <button
                      type="button"
                      className="weq-set-iconbtn"
                      title="复制 rKey"
                      aria-label="复制 rKey"
                      onClick={() => void copyText(r.rkey)}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                  <code className="weq-set-rkey-val">{r.rkey}</code>
                </li>
              );
            })}
          </ul>
        )}
        {cfg?.rkeyUpdatedAt ? (
          <p className="weq-set-note">
            最近更新：{new Date(cfg.rkeyUpdatedAt).toLocaleString('zh-CN')}
          </p>
        ) : null}
      </Card>

      {/* Realtime / db watch */}
      <Card>
        <Row
          label={
            <span className="weq-set-row-icon">
              <Database size={15} strokeWidth={1.8} aria-hidden />
              启用数据库监听
            </span>
          }
          desc="监听 QQ 数据库变化以实时显示新消息、撤回与表情回应。"
          control={
            <Toggle
              checked={realtime}
              disabled={settingsLoading}
              onChange={(v) =>
                void persist(
                  () => setRealtimeLocal(v),
                  () => setRealtime.mutateAsync({ enabled: v }),
                )
              }
              label="启用数据库监听"
            />
          }
        />
      </Card>

      {/* Media completion */}
      <Card title="媒体补全">
        <Row
          label={
            <span className="weq-set-row-icon">
              <ImageDown size={15} strokeWidth={1.8} aria-hidden />
              自动从登录的 QQ 获取 rKey 补全缺失媒体
            </span>
          }
          desc="本地缺失的图片/视频等会通过登录中的 QQ 实例补全。媒体补全几乎决定导出成败。"
          control={
            <Toggle
              checked={mediaEnabled}
              disabled={settingsLoading}
              onChange={(v) =>
                void persist(
                  () => setMediaEnabled(v),
                  () => setMedia.mutateAsync({ enabled: v }),
                )
              }
              label="自动获取 rKey 补全媒体"
            />
          }
        />

        <Row
          indent
          label="用于聊天查看"
          desc="在应用内浏览聊天时补全缺失媒体。"
          control={
            <Toggle
              checked={forViewing}
              disabled={settingsLoading || !mediaEnabled}
              onChange={(v) =>
                void persist(
                  () => setForViewing(v),
                  () => setMedia.mutateAsync({ forViewing: v }),
                )
              }
              label="用于聊天查看"
            />
          }
        />
        <Row
          indent
          label="用于导出补全"
          desc="导出聊天记录时补全缺失媒体。"
          control={
            <Toggle
              checked={forExport}
              disabled={settingsLoading || !mediaEnabled}
              onChange={(v) =>
                void persist(
                  () => setForExport(v),
                  () => setMedia.mutateAsync({ forExport: v }),
                )
              }
              label="用于导出补全"
            />
          }
        />

        <div className="weq-set-subhead">补全媒体类型</div>
        <div className="weq-set-types">
          {MEDIA_TYPE_ROWS.map((row) => (
            <CheckPill
              key={row.key}
              checked={types[row.key]}
              disabled={settingsLoading || !mediaEnabled}
              onChange={(v) =>
                void persist(
                  () => setTypes((t) => ({ ...t, [row.key]: v })),
                  () => setMedia.mutateAsync({ types: { [row.key]: v } }),
                )
              }
            >
              {row.label}
            </CheckPill>
          ))}
        </div>
        <p className="weq-set-note">
          默认补全图片、表情与视频封面图；视频原文件与文件体积较大，按需开启。
        </p>
      </Card>

      {/* ClientKey placeholder */}
      <Card>
        <Row
          label={
            <span className="weq-set-row-icon">
              <KeyRound size={15} strokeWidth={1.8} aria-hidden />
              自动获取 ClientKey
              <span className="weq-set-badge">占位 · 即将支持</span>
            </span>
          }
          desc="用于后续在线能力的凭据获取，当前仅保存设置，尚未启用。"
          control={
            <Toggle
              checked={autoClientKey}
              disabled={settingsLoading}
              onChange={(v) =>
                void persist(
                  () => setAutoClientKey(v),
                  () => setClientKey.mutateAsync({ enabled: v }),
                )
              }
              label="自动获取 ClientKey"
            />
          }
        />
      </Card>
    </div>
  );
}
