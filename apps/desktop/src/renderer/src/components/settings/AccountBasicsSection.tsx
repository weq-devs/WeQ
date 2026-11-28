import { AnimatedDetails } from '../AnimatedDetails';
import { NumericText } from '../NumericText';
import { preciseTimeFormatter as eventTimeFormatter } from '@weq/time';
/**
 * 设置 → 账号基础.
 *
 * Everything tied to the open account: the database key, the live download rkeys,
 * clientkey, plus the behaviour switch (实时消息 / 自动读取 QQ 内存). Realtime +
 * 自动读取 QQ 内存 are stored globally but read most naturally here next to the
 * account they affect. 「监听与读取」不再重复展示当前账号资料。
 *
 * Freshness: the QueryClient keeps data fresh 5 min and does NOT refetch on
 * mount by default, which made this panel show stale rkeys/settings after they
 * changed in the background. Every query here opts into `staleTime: 0` +
 * `refetchOnMount: 'always'`; the account config also polls while open so a
 * freshly-harvested rkey/clientkey appears without reopening. After each
 * settings mutation we refetch so a reopen reflects what was persisted.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import {
  ChevronDown,
  Copy,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Radio,
  RefreshCw,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useTabActive } from '../RetainedTabs.shared';
import { useDialog } from '../Dialog.shared';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { DatabaseReadSettings } from './DatabaseReadSettings';
import { QqCapabilitySetup } from './QqCapabilitySetup';
import { QqStatusReminderSettings } from './QqStatusReminderSettings';
import { CopyButton } from '../CopyButton';
import { formatExpiry } from './AccountBasicsSection.shared';
import { SETTINGS_PAGE_LABELS } from './navigation';

/** rkey `type_` → human label. Mirrors media_download.ts scene constants. */
const RKEY_TYPE_LABEL: Record<number, string> = {
  10: '私聊图片',
  20: '群聊图片',
};

/** 打码用的字符（与 dbKey 同款）。 */
const SECRET_MASK = '*';

/** 密钥值最长打码到 48 位，避免超长 payload 撑爆行宽。 */
function maskSecret(value: string): string {
  return SECRET_MASK.repeat(Math.min(value.length, 48));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 一行「标签 + 密钥值 + 眼睛/复制」的展示行。`secret` 为真时默认打码，点眼睛
 * 展开；`guid` 之类非敏感值直接明文显示，只保留复制。交互与底部 dbKey 一致。
 */
function KeyValueRow({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string | null | undefined;
  secret?: boolean;
}): ReactElement {
  const active = useTabActive();
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!active) {
      setRevealed(false);
    }
  }, [active]);

  const hasValue = Boolean(value);
  const shown = !value ? '未获取' : secret && !revealed ? maskSecret(value) : value;

  return (
    <div className="weq-set-keyfield">
      <span className="weq-set-key-label">{label}</span>
      <code className="weq-set-keyval" title={shown}>
        {shown}
      </code>
      <div className="weq-set-keyfield-actions">
        {secret ? (
          <button
            type="button"
            className="weq-set-iconbtn"
            title={revealed ? '隐藏' : '显示'}
            aria-label={revealed ? `隐藏 ${label}` : `显示 ${label}`}
            disabled={!hasValue}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        ) : null}
        <CopyButton
          text={value ?? ''}
          className="weq-set-iconbtn"
          title={`复制 ${label}`}
          aria-label={`复制 ${label}`}
          disabled={!hasValue}
        >
          <Copy size={15} />
        </CopyButton>
      </div>
    </div>
  );
}

export function AccountBasicsSection({
  page = 'account',
  heading = true,
  databaseKeyTools,
}: {
  page?: 'account' | 'credentials' | 'media' | 'listening';
  heading?: boolean;
  databaseKeyTools?: ReactNode;
}): ReactElement {
  const active = useTabActive();
  const showError = useDialog((s) => s.showError);
  const autoRefresh = useQQAutoRefresh(true);

  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    ...autoRefresh,
    enabled: autoRefresh.enabled && page === 'credentials',
    // rkeys/clientkey are harvested in the background by the monitor; poll so a
    // fresh one shows up (and the expiry countdown re-renders) without reopening.
    refetchInterval: autoRefresh.enabled && page === 'credentials' ? 10_000 : false,
  });
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    ...autoRefresh,
    enabled: autoRefresh.enabled && page !== 'credentials',
  });
  const fullMode = trpc.bootstrap.getFullModeState.useQuery(undefined, {
    ...autoRefresh,
    enabled: autoRefresh.enabled && page === 'credentials',
  });
  const setRealtime = trpc.bootstrap.setRealtimeEnabled.useMutation();
  const setExternalChatpic = trpc.bootstrap.setExternalChatpic.useMutation();
  const pickExternalChatpicDir = trpc.bootstrap.pickExternalChatpicDir.useMutation();

  const [revealKey, setRevealKey] = useState(false);
  useEffect(() => {
    if (!active) {
      setRevealKey(false);
    }
  }, [active]);

  // Local mirror for snappy toggles; re-seeded whenever server data changes.
  const [realtime, setRealtimeLocal] = useState(true);
  // 外部安卓 chatpic 兜底（存在全局设置里）。
  const [externalChatpicDir, setExternalChatpicDir] = useState('');
  const [externalChatpicEnabled, setExternalChatpicEnabled] = useState(false);
  const [pickingChatpic, setPickingChatpic] = useState(false);

  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    setRealtimeLocal(d.realtimeEnabled);
  }, [settings.data]);

  useEffect(() => {
    const d = settings.data;
    if (page !== 'media' || !d) return;
    setExternalChatpicDir(d.externalChatpic.dir);
    setExternalChatpicEnabled(d.externalChatpic.enabled);
  }, [settings.data, page]);

  const cfg = config.data;
  const dbKey = cfg?.dbKey ?? '';
  const maskedKey = dbKey ? maskSecret(dbKey) : '';
  const rkeys = cfg?.rkeys ?? [];
  const clientKey = cfg?.clientKey;
  const settingsLoading = settings.isLoading;
  const attachAllowed = fullMode.data?.allowed === true;
  const settingsPage =
    page === 'media' ? 'resource-loading' : page === 'listening' ? 'database-management' : page;

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

  /** 弹窗选目录 → 校验三个子目录 → 持久化并自动启用。 */
  async function importChatpicDir(): Promise<void> {
    setPickingChatpic(true);
    try {
      const res = await pickExternalChatpicDir.mutateAsync();
      if (res.error) {
        showError('导入失败', res.error);
        return;
      }
      if (res.dir) {
        setExternalChatpicDir(res.dir);
        setExternalChatpicEnabled(true);
      }
      await settings.refetch();
    } catch (e) {
      showError('导入失败', errMsg(e));
    } finally {
      setPickingChatpic(false);
    }
  }

  async function removeChatpicDir(): Promise<void> {
    try {
      await setExternalChatpic.mutateAsync({ dir: '', enabled: false });
      await settings.refetch();
    } catch (e) {
      showError('移除失败', errMsg(e));
    }
  }

  return (
    <div className="weq-set">
      {heading && (
        <SectionHeader
          page={settingsPage}
          title={page === 'listening' ? '监听与读取' : SETTINGS_PAGE_LABELS[settingsPage]}
          desc={page === 'credentials' ? '当前账号的敏感凭据，默认隐藏。' : undefined}
        />
      )}

      {/* Database key */}
      {page === 'credentials' && (
        <>
          <Card title="数据库密钥" icon={<Database size={15} strokeWidth={1.8} />}>
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
                <CopyButton
                  text={dbKey}
                  className="weq-set-iconbtn"
                  title="复制"
                  aria-label="复制密钥"
                  disabled={!dbKey}
                >
                  <Copy size={15} />
                </CopyButton>
              </div>
            </div>
            {cfg?.algos?.['nt_msg.db'] ? (
              <p className="weq-set-note">
                算法：page {cfg.algos['nt_msg.db'].pageHmacAlgorithm} · kdf{' '}
                {cfg.algos['nt_msg.db'].kdfHmacAlgorithm}
              </p>
            ) : null}
            {databaseKeyTools}
          </Card>

          {/* 会话密钥：在线 QQ 内存里采集的 a1 / a2 / d2 / d2key + 设备 guid。
          前四个默认打星号，点眼睛展开（和上面的 dbKey 同款交互）；guid 是设备
          标识、非敏感，直接明文。 */}
          <Card title="会话密钥" icon={<KeyRound size={15} strokeWidth={1.8} />}>
            <div className="weq-set-keylist">
              <KeyValueRow label="a1" value={cfg?.a1} secret />
              <KeyValueRow label="a2" value={cfg?.session?.a2} secret />
              <KeyValueRow label="d2" value={cfg?.session?.d2} secret />
              <KeyValueRow label="d2key" value={cfg?.session?.d2Key} secret />
              <KeyValueRow label="secToken" value={cfg?.session?.secToken} secret />
              <KeyValueRow label="guid" value={cfg?.guid} />
            </div>
            <p className="weq-set-note">
              a1 来自 login.db，a2 / d2 / d2key / secToken 由在线 QQ 进程内存采集（需为当前来源启用
              QQ 在线能力）；guid 是本机设备标识。账号下线后会话物料会被清空。
            </p>
          </Card>

          {/* Download rkeys (show the actual rkey value) */}
          <Card
            title="下载 rKey"
            icon={<KeyRound size={15} strokeWidth={1.8} />}
            action={
              config.error ? (
                <button
                  type="button"
                  className={`weq-set-iconbtn${config.isFetching ? ' is-spinning' : ''}`}
                  title="重试读取 rKey"
                  aria-label="重试读取 rKey"
                  onClick={() => void config.refetch()}
                >
                  <RefreshCw size={14} />
                </button>
              ) : undefined
            }
          >
            {rkeys.length === 0 ? (
              <div className="weq-set-empty">
                {config.isLoading
                  ? '读取中…'
                  : cfg?.qqOnline
                    ? attachAllowed
                      ? '在线实例已连接，正在等待获取 rKey…'
                      : '本次运行尚未启用 QQ 在线能力，不会获取 rKey。'
                    : '未获取到 rKey（需要登录中的 QQ 在线，并为当前来源启用 QQ 在线能力）。'}
              </div>
            ) : (
              <ul className="weq-set-rkey-list">
                {rkeys.map((r) => {
                  const exp = formatExpiry(r.createTime, r.ttlSeconds);
                  return (
                    <li key={`${r.type}-${r.rkey}`} className="weq-set-rkey-item">
                      <div className="weq-set-rkey-head">
                        <span className="weq-set-rkey-type">
                          <NumericText>{RKEY_TYPE_LABEL[r.type] ?? `类型 ${r.type}`}</NumericText>
                        </span>
                        <span className={`weq-set-rkey-exp${exp.expired ? ' is-expired' : ''}`}>
                          {exp.text}
                        </span>
                        <CopyButton
                          text={r.rkey}
                          className="weq-set-iconbtn"
                          title="复制 rKey"
                          aria-label="复制 rKey"
                        >
                          <Copy size={13} />
                        </CopyButton>
                      </div>
                      <KeyValueRow label="rKey" value={r.rkey} secret />
                    </li>
                  );
                })}
              </ul>
            )}
            {cfg?.rkeyUpdatedAt ? (
              <p className="weq-set-note">
                最近更新：
                {
                  <span className="weq-number weq-number-inherit">
                    {eventTimeFormatter.format(new Date(cfg.rkeyUpdatedAt))}
                  </span>
                }
              </p>
            ) : null}
          </Card>

          {/* ClientKey */}
          <Card
            title="ClientKey"
            icon={<KeyRound size={15} strokeWidth={1.8} />}
            action={
              config.error ? (
                <button
                  type="button"
                  className={`weq-set-iconbtn${config.isFetching ? ' is-spinning' : ''}`}
                  title="重试读取 ClientKey"
                  aria-label="重试读取 ClientKey"
                  onClick={() => void config.refetch()}
                >
                  <RefreshCw size={14} />
                </button>
              ) : undefined
            }
          >
            {!clientKey ? (
              <div className="weq-set-empty">
                {config.isLoading
                  ? '读取中…'
                  : cfg?.qqOnline
                    ? attachAllowed
                      ? '在线实例已连接，正在等待获取 ClientKey…'
                      : '本次运行尚未启用 QQ 在线能力，不会获取 ClientKey。'
                    : '未获取到 ClientKey（需要登录中的 QQ 在线，并为当前来源启用 QQ 在线能力）。'}
              </div>
            ) : (
              <div className="weq-set-rkey-item">
                <div className="weq-set-rkey-head">
                  <span className="weq-set-rkey-type">
                    Key Index{' '}
                    <span className="weq-number weq-number-inherit">{clientKey.keyIndex}</span>
                  </span>
                  <span
                    className={`weq-set-rkey-exp${
                      formatExpiry(Math.floor(clientKey.fetchedAt / 1000), clientKey.ttlSeconds)
                        .expired
                        ? ' is-expired'
                        : ''
                    }`}
                  >
                    {
                      formatExpiry(Math.floor(clientKey.fetchedAt / 1000), clientKey.ttlSeconds)
                        .text
                    }
                  </span>
                  <CopyButton
                    text={clientKey.clientKey}
                    className="weq-set-iconbtn"
                    title="复制 ClientKey"
                    aria-label="复制 ClientKey"
                  >
                    <Copy size={13} />
                  </CopyButton>
                </div>
                <KeyValueRow label="ClientKey" value={clientKey.clientKey} secret />
              </div>
            )}
          </Card>
        </>
      )}
      {/* Realtime / db watch */}
      {page === 'listening' && (
        <Card
          title="监听与读取"
          icon={<Radio size={15} strokeWidth={1.8} />}
          settingId="database-listening"
          resetId="realtime"
        >
          <Row
            settingId="realtime-enabled"
            label="启用数据库监听"
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
          <DatabaseReadSettings embedded />
        </Card>
      )}
      {page === 'account' && (
        <>
          <QqCapabilitySetup mode={settings.data?.qqCapabilityMode} />
          <QqStatusReminderSettings />
        </>
      )}
      {/* 外部安卓图片缓存（放最下面，带引导文案） */}
      {page === 'media' && (
        <Card
          title="外部安卓图片缓存"
          icon={<Smartphone size={15} strokeWidth={1.8} />}
          settingId="external-chatpic"
        >
          <Row
            label="允许使用外部安卓图片缓存"
            desc={
              externalChatpicDir
                ? `聊天图片在本机找不到时，会先到该备份目录按 md5 寻址，再回退到网络下载。 ${externalChatpicDir}`
                : '未导入。导入安卓 QQ 的 chatpic 缓存备份后，可找回本机缺失的聊天图片。'
            }
            control={
              <Toggle
                checked={externalChatpicEnabled}
                disabled={!externalChatpicDir || settingsLoading}
                onChange={(v) =>
                  void persist(
                    () => setExternalChatpicEnabled(v),
                    () =>
                      setExternalChatpic.mutateAsync({
                        dir: externalChatpicDir,
                        enabled: v,
                      }),
                  )
                }
                label="允许使用外部安卓图片缓存"
              />
            }
          />
          <Row
            label="导入目录"
            desc="选择已完整备份的 chatpic 目录，程序会检查 chatraw / chatimg / chatthumb 三个子目录是否齐全。"
            indent
            control={
              <div className="weq-set-btn-group">
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={pickingChatpic}
                  onClick={() => void importChatpicDir()}
                >
                  <FolderOpen size={14} aria-hidden />
                  {pickingChatpic ? '校验中…' : '选择并导入…'}
                </button>
                {externalChatpicDir ? (
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft weq-set-btn-del"
                    onClick={() => void removeChatpicDir()}
                  >
                    <Trash2 size={14} aria-hidden />
                    移除
                  </button>
                ) : null}
              </div>
            }
          />
          <AnimatedDetails className="weq-set-details">
            <summary>
              <ChevronDown size={13} aria-hidden />
              安卓 chatpic 备份教程（点击展开）
            </summary>
            <div className="weq-set-details-body">
              <p>
                手机 QQ 的聊天图片缓存在{' '}
                <code>/sdcard/Android/data/com.tencent.mobileqq/Tencent/MobileQQ/chatpic</code>{' '}
                目录（部分机型是{' '}
                <code>
                  /storage/emulated/0/Android/data/com.tencent.mobileqq/Tencent/MobileQQ/chatpic
                </code>
                ）。把这个目录<strong>完整</strong>备份到电脑，三个子目录 <code>chatraw</code> /{' '}
                <code>chatimg</code> / <code>chatthumb</code> 都要保留。
              </p>
              <p className="weq-set-details-h">备份方案（任选其一）：</p>
              <ol>
                <li>
                  <strong>ADB 命令（推荐，最稳）</strong>：手机开启「开发者选项 → USB
                  调试」，连接电脑后执行
                  <code>
                    adb pull /sdcard/Android/data/com.tencent.mobileqq/Tencent/MobileQQ/chatpic
                    &lt;电脑上的目标目录&gt;
                  </code>
                  ，把整个目录拉下来。
                </li>
                <li>
                  <strong>文件管理器复制</strong>：Android 11+ 的系统文件管理器访问{' '}
                  <code>Android/data</code> 受限，建议用 MT 管理器等第三方文件管理器，或 Root
                  后的文件管理器，把 chatpic 整个文件夹复制到电脑。
                </li>
                <li>
                  <strong>手机整机备份</strong>：用手机自带的「备份与恢复」或第三方备份 App 把 QQ
                  数据整体备份，再从备份里取出 chatpic 目录。
                </li>
              </ol>
              <p>
                导入时请选择电脑上那个 chatpic 目录本身（即里面直接能看到 chatraw / chatimg /
                chatthumb），而不是它的父目录。
              </p>
            </div>
          </AnimatedDetails>
        </Card>
      )}
    </div>
  );
}
