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

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ChevronDown,
  CheckCheck,
  Copy,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Network,
  Radio,
  RefreshCw,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useTabActive } from '../RetainedTabs.shared';
import { useDialog } from '../Dialog.shared';
import { useToast } from '../Toast.shared';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { LongTermAuthorizationSection } from './LongTermAuthorizationSection';
import { DatabaseReadSettings } from './DatabaseReadSettings';
import { FullFunctionSetup } from './FullFunctionSetup';
import { NotificationMethodSelect } from './NotificationMethodSelect';
import { CopyButton } from '../CopyButton';
import { QqProxyRecovery } from '../QqProxyConnection';
import { formatExpiry } from './AccountBasicsSection.shared';

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
}: {
  page?: 'account' | 'credentials' | 'media' | 'listening';
  heading?: boolean;
}): ReactElement {
  const active = useTabActive();
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);
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
  const systemInfo = trpc.bootstrap.systemInfo.useQuery(undefined, {
    ...autoRefresh,
    enabled: autoRefresh.enabled && page === 'account',
  });

  const setRealtime = trpc.bootstrap.setRealtimeEnabled.useMutation();
  const setAutoAttachQq = trpc.bootstrap.setAutoAttachQq.useMutation();
  const setRestrictedIndicator = trpc.bootstrap.setRestrictedModeIndicatorEnabled.useMutation();
  const setReadSyncEnabled = trpc.bootstrap.setReadSyncEnabled.useMutation();
  const [qqSyncPortDraft, setQqSyncPortDraft] = useState<string | null>(null);
  const pushToast = useToast((state) => state.push);
  const qqSyncStatus = trpc.bootstrap.getQqClientSyncStatus.useQuery(undefined, {
    enabled: active && page === 'account',
    staleTime: 0,
    refetchInterval: active && page === 'account' ? 5000 : false,
  });
  const setQqProxyIndicator = trpc.bootstrap.setQqProxyIndicatorEnabled.useMutation({
    onSuccess: async () => {
      await settings.refetch();
    },
    onError: (error) => showError('保存失败', error.message),
  });
  const setQqClientSync = trpc.bootstrap.setQqClientSyncEnabled.useMutation({
    onSuccess: () => {
      void settings.refetch();
      void qqSyncStatus.refetch();
    },
    onError: (error) => showError('更改 QQ 同步设置失败', error.message),
  });
  const setQqClientSyncPort = trpc.bootstrap.setQqClientSyncPort.useMutation({
    onSuccess: async ({ port }) => {
      await qqSyncStatus.refetch();
      setQqSyncPortDraft(null);
      pushToast({
        tone: 'success',
        title: 'QQ 代理端口已更新',
        message: `请在 QQ 登录页填写端口 ${port}，然后重新连接。`,
      });
    },
    onError: (error) => showError('更改 QQ 代理端口失败', error.message),
  });
  const proxy = qqSyncStatus.data;
  const qqSyncPort = proxy?.port;
  const proxyStatusText = qqSyncStatus.isError
    ? '无法读取代理状态'
    : !proxy
      ? '正在检查代理'
      : proxy.connected
        ? 'QQ 已连接代理'
        : proxy.running
          ? 'QQ 代理未连接'
          : proxy.error || '本机代理尚未启动';
  const syncTasks = settings.data?.qqClientSyncEnabled ? proxy?.tasks : null;
  const taskError = syncTasks?.error;
  const proxyStatusDetails = [
    proxyStatusText,
    syncTasks?.pending ? `待同步 ${syncTasks.pending} 项` : '',
    // 等待连接由当前代理状态表示。队列在重试前可能仍保留上一次等待的原因。
    taskError !== '等待 QQ 通过代理连接' && taskError !== proxyStatusText ? taskError : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const newQqSyncPort = Number(qqSyncPortDraft);
  const canSaveQqSyncPort =
    qqSyncPort !== undefined &&
    Number.isInteger(newQqSyncPort) &&
    newQqSyncPort >= 1 &&
    newQqSyncPort <= 65535 &&
    newQqSyncPort !== qqSyncPort &&
    !setQqClientSync.isPending &&
    !setQqClientSyncPort.isPending;
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
  const [autoAttach, setAutoAttach] = useState(false);
  const [restrictedIndicator, setRestrictedIndicatorLocal] = useState(true);
  const [savingIndicator, setSavingIndicator] = useState(false);
  const indicatorPending = useRef(false);
  const [reportRead, setReportRead] = useState(false);
  const [manualReadReport, setManualReadReport] = useState(false);
  const [savingReadSync, setSavingReadSync] = useState(false);
  const readSyncPending = useRef(false);
  const readSyncActive = useRef(active);
  readSyncActive.current = active;
  useEffect(() => {
    readSyncActive.current = active;
    return () => {
      readSyncActive.current = false;
    };
  }, [active]);
  // 外部安卓 chatpic 兜底（存在全局设置里）。
  const [externalChatpicDir, setExternalChatpicDir] = useState('');
  const [externalChatpicEnabled, setExternalChatpicEnabled] = useState(false);
  const [pickingChatpic, setPickingChatpic] = useState(false);

  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    setRealtimeLocal(d.realtimeEnabled);
    setAutoAttach(d.autoAttachQq);
    setRestrictedIndicatorLocal(d.restrictedModeIndicatorEnabled !== false);
    setReportRead(d.reportReadEnabled);
    setManualReadReport(d.manualReadReportEnabled);
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
  const isMac = systemInfo.data?.platformKind === 'darwin';

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

  async function toggleReportRead(enabled: boolean): Promise<void> {
    if (readSyncPending.current || !active || !settings.data || settings.error) return;
    readSyncPending.current = true;
    setSavingReadSync(true);
    try {
      if (
        enabled &&
        !(await confirm(
          '向 QQ 服务器上报已读位置',
          '开启后，自动阅读与手动标记已读都会向 QQ 服务器上报已读位置，可能清除其他客户端的未读提醒。标为未读不能恢复已清除的提醒。',
          { danger: 'outline', okLabel: '开启上报' },
        ))
      )
        return;
      if (!readSyncActive.current) return;
      await setReadSyncEnabled.mutateAsync({ enabled });
      if (!readSyncActive.current) return;
      setReportRead(enabled);
      setManualReadReport(enabled);
      await settings.refetch();
    } catch (error) {
      try {
        const actual = await settings.refetch();
        if (actual?.data && readSyncActive.current) {
          setReportRead(actual.data.reportReadEnabled);
          setManualReadReport(actual.data.manualReadReportEnabled);
        }
      } catch {
        // 回读也失败时保留最后已知组合，不将保存失败误报为成功。
      } finally {
        if (readSyncActive.current) showError('保存失败', errMsg(error));
      }
    } finally {
      readSyncPending.current = false;
      setSavingReadSync(false);
    }
  }

  async function toggleRestrictedIndicator(enabled: boolean): Promise<void> {
    if (indicatorPending.current) return;
    indicatorPending.current = true;
    setSavingIndicator(true);
    const previous = restrictedIndicator;
    setRestrictedIndicatorLocal(enabled);
    try {
      await setRestrictedIndicator.mutateAsync({ enabled });
      await settings.refetch();
    } catch (error) {
      setRestrictedIndicatorLocal(previous);
      showError('保存失败', errMsg(error));
    } finally {
      indicatorPending.current = false;
      setSavingIndicator(false);
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
          page={
            page === 'account' || page === 'credentials'
              ? page
              : page === 'media'
                ? 'resource-loading'
                : 'database-management'
          }
          title={
            {
              account: '在线能力与授权',
              credentials: '凭据管理',
              media: '资源加载',
              listening: '监听与读取',
            }[page]
          }
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
          <FullFunctionSetup isMac={isMac}>
            <Row
              settingId="auto-full-mode"
              label="自动启用 QQ 在线能力"
              desc="打开账号后自动尝试读取 QQ 会话凭据并启用 QQ 在线能力。关闭后仍可在「在线能力受限」详情中为当前来源手动启用；手动请求仅在宿主本次运行中有效，不改变下次启动偏好。"
              control={
                <Toggle
                  checked={autoAttach}
                  disabled={settingsLoading}
                  onChange={(v) =>
                    void persist(
                      () => setAutoAttach(v),
                      () => setAutoAttachQq.mutateAsync({ enabled: v }),
                    )
                  }
                  label="自动启用 QQ 在线能力"
                />
              }
            />
            <Row
              settingId="restricted-mode-indicator"
              label="在线能力受限时在窗口右上角显示"
              control={
                <Toggle
                  checked={restrictedIndicator}
                  disabled={
                    settingsLoading || !settings.data || Boolean(settings.error) || savingIndicator
                  }
                  onChange={(value) => void toggleRestrictedIndicator(value)}
                  label="在线能力受限时在窗口右上角显示"
                />
              }
            />
            <Row
              label="在线能力受限时通知"
              desc="QQ 在线能力就绪后再次受限时，按通知设置提醒。授权请求、主动操作错误和启用进度不受影响。"
              control={<NotificationMethodSelect event="runtime" />}
            />
          </FullFunctionSetup>
          <Card title="已读同步" icon={<CheckCheck size={15} />} resetId="read-sync">
            <Row
              settingId="read-sync"
              desc="向 QQ 服务器上报在 WeQ 阅读和手动标记已读的位置，可能清除其他端的未读提醒。仅在 QQ 在线能力已启用且账号在线时生效。"
              control={
                <Toggle
                  checked={reportRead || manualReadReport}
                  disabled={
                    settingsLoading ||
                    !settings.data ||
                    Boolean(settings.error) ||
                    savingReadSync ||
                    setReadSyncEnabled.isPending
                  }
                  onChange={(v) => void toggleReportRead(v)}
                  label="向 QQ 服务器上报已读位置"
                />
              }
            />
            {reportRead !== manualReadReport ? (
              <p className="weq-set-note">
                {reportRead ? '仅自动阅读上报，沿用原设置' : '仅手动标记上报，沿用原设置'}
              </p>
            ) : null}
          </Card>
          <Card
            settingId="qq-proxy-connection"
            title="QQ 代理连接"
            icon={<Network size={15} strokeWidth={1.8} />}
            resetId="qq-client-sync"
          >
            <Row
              settingId="qq-client-sync"
              desc="QQ 通过本机代理连接后生效。已读同步沿用上方的上报设置。"
              control={
                <Toggle
                  checked={settings.data?.qqClientSyncEnabled ?? false}
                  disabled={
                    settingsLoading || setQqClientSync.isPending || setQqClientSyncPort.isPending
                  }
                  onChange={(enabled) => setQqClientSync.mutate({ enabled })}
                  label="自动同步本人消息与已读"
                />
              }
            />
            <Row
              settingId="qq-proxy-indicator"
              control={
                <Toggle
                  checked={settings.data?.qqProxyIndicatorEnabled ?? true}
                  disabled={
                    !settings.data || Boolean(settings.error) || setQqProxyIndicator.isLoading
                  }
                  onChange={(enabled) => setQqProxyIndicator.mutate({ enabled })}
                  label="QQ 代理未连接时在窗口右上角显示"
                />
              }
            />
            <Row
              label="代理端口"
              desc={
                qqSyncPort === undefined
                  ? '在 QQ 登录页使用 HTTP 代理，地址为 127.0.0.1。'
                  : `在 QQ 登录页选择 HTTP 代理，地址填 127.0.0.1，端口填 ${qqSyncPort}，用户名和密码留空。改端口后需在 QQ 中更新并重新登录。`
              }
              control={
                <form
                  className="weq-set-btn-group"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (canSaveQqSyncPort) setQqClientSyncPort.mutate({ port: newQqSyncPort });
                  }}
                >
                  <input
                    className="weq-set-input weq-set-input-sm weq-number"
                    aria-label="QQ 代理端口"
                    inputMode="numeric"
                    value={qqSyncPortDraft ?? qqSyncPort ?? ''}
                    disabled={qqSyncPort === undefined || setQqClientSyncPort.isPending}
                    onChange={(event) =>
                      setQqSyncPortDraft(event.target.value.replace(/\D/g, '').slice(0, 5))
                    }
                    title="请输入 1–65535 之间的整数"
                  />
                  <button
                    type="submit"
                    className="weq-set-btn weq-set-btn-primary weq-set-btn-sm"
                    disabled={!canSaveQqSyncPort}
                  >
                    保存端口
                  </button>
                </form>
              }
            />
            <p className="weq-set-note" role="status">
              {proxyStatusDetails}
            </p>
            {proxy?.connectionExpected && !proxy.connected && !qqSyncStatus.isError && (
              <QqProxyRecovery onLaunch={() => void qqSyncStatus.refetch()} />
            )}
            <p className="weq-set-note">
              代理独立保持运行，WeQ 重启后自动接续。关闭自动同步会保留转发；停用代理前请先恢复 QQ
              的网络设置。
            </p>
          </Card>
          <LongTermAuthorizationSection />
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
          <details className="weq-set-details">
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
          </details>
        </Card>
      )}
    </div>
  );
}
