import { preciseTimeFormatter as eventTimeFormatter } from '@weq/time';
import { NumericText } from '../NumericText';
/**
 * 设置 → 全局设置.
 *
 * App-wide, account-independent items: 现有配置账号列表 + 默认进入账号选择 +
 * 数据与缓存清理。版本信息与软件更新搬到了「版本」页（VersionSection）。
 *
 * Data sources:
 *   - `bootstrap.listAccountConfigs`  — saved account configs
 *   - `bootstrap.getAutoEnter`        — auto-enter target
 *
 * Queries here use `staleTime: 0` + `refetchOnMount: 'always'` so reopening the
 * dialog always shows fresh state (the global QueryClient otherwise keeps
 * everything fresh for 5 min and never refetches on mount).
 */

import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  AppWindow,
  Cloud,
  ChevronRight,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Shirt,
  RotateCcw,
  Trash2,
  User,
} from 'lucide-react';
import type { StorageUsageItem } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { useDialog } from '../Dialog.shared';
import { useToast } from '../Toast.shared';
import { LoadingIndicator } from '../LoadingIndicator';
import { useViewState } from '../../state/view';
import { QqAvatar } from '../QqAvatar';
import { Card, CheckPill, Row, SectionHeader, Toggle } from './controls';
import { SettingsNavigateContext } from './controls.shared';
import { useTabActive } from '../RetainedTabs.shared';
import { ToastSettingsCard } from './ToastSettingsCard';
import { NotificationEventSettings } from './NotificationEventSettings';
import type { SettingsSearchTarget } from './searchTarget';
import { WebNotificationsSection } from './WebNotificationsSection';
import { IS_WEB } from '../../lib/target.shared';
import { useRemoteImagePreference } from '../../lib/remoteWebStartup';
import { groupStorageEntries, mergeStorageEntries } from '../../lib/storage-entries';
import '../../styles/storage-management.css';
import { QqShowSettings } from './QqShowSettings';
import { SharedDisplayToggle } from './SharedDisplayToggle';
import { BadgeSettingRow } from './UnreadBadgeSettings';
import { ChatImageCacheSettings, ChatMessagePrewarmSettings } from './ChatImageCacheSettings';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function backupDescription(item: StorageUsageItem): string | null {
  if (!item.backup) return null;
  const { at, status } = item.backup;
  const date =
    at && /(?:Z|[+-]\d{2}:\d{2})$/.test(at) && Number.isFinite(Date.parse(at))
      ? `${eventTimeFormatter.format(new Date(at))}（北京时间）`
      : at || '时间未知';
  return `${date} · ${status === 'linked' ? '已关联修复记录' : status === 'orphan' ? '无关联修复记录' : '未识别备份'}`;
}

export function GlobalSettingsSection({
  section = 'general',
  heading = true,
  recallNotifications,
  notificationTarget,
}: {
  section?: 'general' | 'accounts' | 'storage' | 'logs' | 'network';
  heading?: boolean;
  recallNotifications?: ReactNode;
  notificationTarget?: SettingsSearchTarget | null;
}): ReactElement {
  const navigate = useContext(SettingsNavigateContext);
  const active = useTabActive();
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);
  const pushToast = useToast((s) => s.push);
  // 用来把「当前已登录的账号」标出来并禁掉它的删除按钮。
  const openedUin = useViewState((s) => s.openedUin);
  const [preferCdn, setPreferCdn] = useState(false);

  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const preferRemoteCdn = useRemoteImagePreference(settings.data?.preferRemoteCdn);
  const accounts = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    enabled: active && section === 'accounts',
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  // 「当前账号」要按 configId 认：同一个 QQ 号可能同时有在线账号和静态账号，
  // 只比 uin 会给两条记录都打上「当前账号」。
  const currentConfig = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active && section === 'accounts',
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const autoEnter = trpc.bootstrap.getAutoEnter.useQuery(undefined, {
    enabled: active && section === 'accounts',
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setAutoEnter = trpc.bootstrap.setAutoEnter.useMutation();
  const clearAutoEnter = trpc.bootstrap.clearAutoEnter.useMutation();
  const deleteAccount = trpc.bootstrap.deleteAccountConfig.useMutation();
  const setPreferCdnMut = trpc.bootstrap.setPreferCdn.useMutation();

  // 存储统计包含持久数据，选择与清理只针对后端明确标记的可清理项。
  const cacheUsage = trpc.bootstrap.listStorageUsage.useQuery(undefined, {
    enabled: active && section === 'storage',
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const clearStorageData = trpc.bootstrap.clearStorageData.useMutation();
  const [cleaning, setCleaning] = useState(false);
  const [restartIds, setRestartIds] = useState<string[]>([]);
  const cleanupBusy = cleaning || clearStorageData.isLoading;
  const [pickedCats, setPickedCats] = useState<Set<string>>(new Set());
  const [storageDetails, setStorageDetails] = useState<string | null>(null);
  const [expandedStorageGroups, setExpandedStorageGroups] = useState<Set<string>>(new Set());
  const storageHeadingId = useId();
  const [confirmingSelection, setConfirmingSelection] = useState(false);
  const selectionInFlight = useRef(false);
  const cacheItems = (cacheUsage.data ?? []).filter(
    (item) =>
      item.management !== 'backup' &&
      item.management !== 'downloads' &&
      item.management !== 'runtime',
  );
  const clearableItems = cacheItems.filter(
    (item) => item.clearable && (item.bytes > 0 || item.incomplete),
  );
  const storageGroups = groupStorageEntries(cacheItems);
  const storageEntries = storageGroups.flatMap((group) => group.entries);
  const safeCacheItems = clearableItems.filter(
    (item) => item.action === 'cache' || (!item.action && !item.requiresExit),
  );
  const totalCacheBytes = cacheItems.reduce((sum, it) => sum + it.bytes, 0);
  const clearableBytes = safeCacheItems.reduce((sum, it) => sum + it.bytes, 0);
  const availableCleanupBytes = clearableItems.reduce((sum, item) => sum + item.bytes, 0);
  const selectedUnavailable = storageEntries.filter(
    ({ item }) => pickedCats.has(item.id) && !item.clearable,
  ).length;
  const selectedIds = new Set(
    storageEntries
      .filter(({ item }) => item.clearable && pickedCats.has(item.id))
      .flatMap(({ members }) => members.map((item) => item.id)),
  );
  const selectedItems = clearableItems.filter((item) => selectedIds.has(item.id));
  const cleanupBytes = (pickedCats.size > 0 ? selectedItems : safeCacheItems).reduce(
    (sum, item) => sum + item.bytes,
    0,
  );
  const cleanupDanger = selectedItems.some((item) => item.requiresExit || item.action === 'data')
    ? 'solid'
    : 'outline';

  useEffect(() => {
    const enabled = settings.data?.preferCdn;
    if (typeof enabled === 'boolean') setPreferCdn(enabled);
  }, [settings.data?.preferCdn]);

  async function changeStorageSelection(next: Set<string>) {
    if (selectionInFlight.current) return;
    const impacts = storageEntries.flatMap(({ item }) => {
      if (!next.has(item.id) || pickedCats.has(item.id)) return [];
      const impact = item.clearable
        ? (item.confirmation ?? (item.requiresExit ? item.reason : undefined))
        : `此项当前无法在这里清理。${item.reason}`;
      return impact ? [`${item.label}：${impact}`] : [];
    });
    if (!impacts.length) {
      setPickedCats(next);
      return;
    }
    selectionInFlight.current = true;
    setConfirmingSelection(true);
    try {
      const ok = await confirm('勾选项的清理影响', `${impacts.join('\n\n')}\n\n确认勾选？`, {
        okLabel: '勾选',
        cancelLabel: '取消',
        tone: 'warning',
      });
      if (ok) setPickedCats(next);
    } finally {
      selectionInFlight.current = false;
      setConfirmingSelection(false);
    }
  }
  const selectionDisabled = cleanupBusy || confirmingSelection || cacheUsage.isFetching;
  const cacheMulti = useMultiSelection({
    ids: storageGroups.flatMap(({ id, entries }) =>
      expandedStorageGroups.has(id) ? entries.map(({ item }) => item.id) : [],
    ),
    selected: pickedCats,
    onChange: (next) => void changeStorageSelection(next),
    disabled: selectionDisabled,
  });

  const storageItem = (item: StorageUsageItem, members: StorageUsageItem[]) => (
    <div
      key={item.id}
      className={`weq-storage-item${item.clearable ? '' : ' is-readonly'}`}
      data-cache-id={item.id}
    >
      <div className="weq-storage-item-head">
        <CheckPill
          checked={pickedCats.has(item.id)}
          disabled={selectionDisabled}
          onChange={() => cacheMulti.toggle(item.id)}
        >
          <HardDrive size={14} strokeWidth={1.8} aria-hidden />
          <span>{item.label}</span>
        </CheckPill>
        <span className="weq-storage-size">
          <span>
            {item.incomplete ? '至少 ' : ''}
            <NumericText>{formatBytes(item.bytes)}</NumericText>
          </span>
          {!item.clearable ? (
            <small>仅统计</small>
          ) : item.exitOnly ? (
            <small>退出后清理</small>
          ) : null}
        </span>
        <button
          type="button"
          className="weq-set-iconbtn weq-storage-details-toggle"
          aria-label={`查看${item.label}的详情`}
          aria-expanded={storageDetails === item.id}
          title="查看详情"
          onClick={() => setStorageDetails(storageDetails === item.id ? null : item.id)}
        >
          <ChevronRight size={14} aria-hidden />
        </button>
      </div>
      {storageDetails === item.id && (
        <div className="weq-storage-detail">
          {item.backup && <small>{backupDescription(item)}</small>}
          {item.category === 'program-backups' && <small>{item.reason}</small>}
          <small>{item.clearable ? (item.confirmation ?? item.reason) : item.reason}</small>
          {item.category === 'database-validation' && (
            <small>副本可能共用磁盘空间，实际腾出的空间以系统显示为准。</small>
          )}
          {item.management === 'repair' && navigate && (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
              onClick={() => navigate('database-repair')}
            >
              数据库修复
            </button>
          )}
          {members.map((member) => (
            <div className="weq-storage-source" key={member.id}>
              <small className="weq-storage-path">{member.path}</small>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                onClick={() =>
                  void client.bootstrap.revealStorageItem
                    .mutate({ id: member.id })
                    .catch((error: unknown) => showError('定位失败', errMsg(error)))
                }
              >
                <FolderOpen size={14} aria-hidden />
                定位
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  async function onClearWeqCache(explicitTargets?: StorageUsageItem[]): Promise<void> {
    const targets = explicitTargets ?? (pickedCats.size > 0 ? selectedItems : safeCacheItems);
    const ids = targets.map((item) => item.id);
    if (ids.length === 0) return;
    const willFree = targets.reduce((sum, it) => sum + it.bytes, 0);
    const displayTargets = mergeStorageEntries(targets).map(({ item }) => item);
    const label =
      explicitTargets || pickedCats.size > 0
        ? displayTargets.map((t) => t.label).join('、')
        : '全部可清理缓存';
    const risky = targets.some((item) => item.requiresExit);
    const extra = displayTargets.flatMap((item) =>
      item.confirmation ? [`${item.label}：${item.confirmation}`] : [],
    );
    const ok = await confirm(
      risky ? '清除所选数据' : '清理 WeQ 缓存',
      risky
        ? `将永久删除「${label}」，预计清除约 ${formatBytes(willFree)}。只删除所选路径中的数据，不会额外清理其它 QQ 数据目录。先清除可直接清除的项目；若有占用项，会另行询问是否重启。\n\n${extra.join('\n\n')}\n\n确认清除？`
        : `将删除「${label}」，预计释放约 ${formatBytes(willFree)}。需要时会重新下载或生成；保留数据不受影响。${extra.length ? `\n\n${extra.join('\n')}\n\n` : ''}是否继续？`,
      {
        danger: targets.some((item) => item.requiresExit || item.action === 'data')
          ? 'solid'
          : 'outline',
        okLabel: risky ? '清除' : '清理',
        cancelLabel: '取消',
        tone: 'warning',
      },
    );
    if (!ok) return;
    setCleaning(true);
    try {
      const res = await clearStorageData.mutateAsync({ ids, acknowledgeRisk: true });
      setRestartIds(res.restartIds);
      await cacheUsage.refetch();
      const failedIds = new Set(res.failed.flatMap((item) => (item.id ? [item.id] : [])));
      setPickedCats(
        new Set([
          ...failedIds,
          ...storageEntries
            .filter(({ item }) => !item.clearable && pickedCats.has(item.id))
            .map(({ item }) => item.id),
          ...storageEntries
            .filter(({ members }) => members.some((item) => failedIds.has(item.id)))
            .map(({ item }) => item.id),
        ]),
      );
      pushToast({
        tone: res.failed.length > 0 ? 'warning' : 'success',
        title: res.failed.length > 0 ? '部分项目未能清除' : '清理已完成',
        message: `已清除 ${res.cleared.length} 项，共 ${formatBytes(res.freedBytes)}${res.failed.length ? `；${res.failed.map((item) => `${item.label}：${item.error}`).join('；')}` : ''}`,
      });
      if (res.restartIds.length) await retryOccupiedStorage(res.restartIds);
    } catch (e) {
      showError('清理缓存失败', errMsg(e));
    } finally {
      setCleaning(false);
    }
  }

  async function retryOccupiedStorage(ids: string[]): Promise<void> {
    const labels = ids.map((id) => cacheItems.find((item) => item.id === id)?.label ?? id);
    const ok = await confirm(
      '剩余项目需退出 WeQ 后清理',
      `可直接清除的项目已经处理。「${labels.join('、')}」需要退出后清理。完成后 WeQ 会自动打开。若由 QQ 等其他程序占用，请先关闭对应程序。`,
      { danger: 'solid', okLabel: '重启并继续清除', cancelLabel: '暂不重启', tone: 'warning' },
    );
    if (!ok) return;
    await clearStorageData.mutateAsync({ ids, acknowledgeRisk: true, afterExit: true });
    setRestartIds([]);
    pushToast({
      tone: 'warning',
      title: '已安排清除剩余项目',
      durationKind: 'success',
      message: '清除完成后自动重新打开 WeQ。',
    });
  }

  async function onSetAutoEnter(uin: string, dataDir?: string): Promise<void> {
    try {
      await setAutoEnter.mutateAsync({ uin, dataDir });
      await autoEnter.refetch();
    } catch (e) {
      showError('设置默认进入账号失败', errMsg(e));
    }
  }

  async function onClearAutoEnter(): Promise<void> {
    try {
      await clearAutoEnter.mutateAsync();
      await autoEnter.refetch();
    } catch (e) {
      showError('清除默认进入账号失败', errMsg(e));
    }
  }

  // 删除账号配置。和 bootstrap 选择页 / 左栏底部弹层走同一个后端接口，
  // 删的只是 WeQ 侧保存的配置（密钥、数据目录、昵称快照），不动 QQ 本体数据。
  // 当前已登录的账号不给删——删掉配置后界面还挂在这个账号上，状态会自相矛盾。
  async function onDeleteAccount(acc: {
    configId: string;
    uin: string;
    displayName?: string;
  }): Promise<void> {
    const label = acc.displayName || acc.uin;
    const ok = await confirm(
      '删除账号配置',
      `将删除「${label}」在 WeQ 中保存的配置（数据库密钥、数据目录等），下次需要重新获取密钥。QQ 本体的聊天记录不受影响。是否继续？`,
      { danger: 'outline', okLabel: '删除', cancelLabel: '取消', tone: 'warning' },
    );
    if (!ok) return;
    try {
      await deleteAccount.mutateAsync({ configId: acc.configId });
      await Promise.all([accounts.refetch(), autoEnter.refetch()]);
      pushToast({ tone: 'success', title: `账号配置「${label}」已移除` });
    } catch (e) {
      showError('删除账号配置失败', errMsg(e));
    }
  }

  async function onSetPreferCdn(next: boolean, remote = false): Promise<void> {
    const prev = preferCdn;
    if (!remote) setPreferCdn(next);
    try {
      await setPreferCdnMut.mutateAsync({ enabled: next, remote });
      await settings.refetch();
    } catch (e) {
      if (!remote) setPreferCdn(prev);
      await settings.refetch();
      showError(remote ? '保存 Remote 图片设置失败' : '保存 CDN 设置失败', errMsg(e));
    }
  }

  const accountList = accounts.data ?? [];
  const autoEnterTarget = autoEnter.data;

  return (
    <div className={`weq-set${section === 'storage' ? ' weq-storage-settings' : ''}`}>
      {heading && (
        <SectionHeader
          page={
            (
              {
                general: 'global',
                accounts: 'accounts',
                storage: 'weq-storage',
                logs: 'logs',
                network: 'resource-loading',
              } as const
            )[section]
          }
          title={
            {
              general: '通知与提醒',
              accounts: 'WeQ 账号管理',
              storage: 'WeQ 存储管理',
              logs: '日志',
              network: '资源加载',
            }[section]
          }
        />
      )}

      {section === 'general' && (
        <>
          <NotificationEventSettings
            recallScope={recallNotifications}
            target={notificationTarget}
          />
          <ToastSettingsCard />
          <Card icon={<AppWindow size={15} strokeWidth={1.8} />} resetId="application-badge">
            <BadgeSettingRow
              name="applicationBadge"
              settingId="application-unread-badge"
              label="应用图标未读角标"
              fallback
            />
          </Card>
          {IS_WEB && <WebNotificationsSection />}
        </>
      )}

      {/* Account list */}
      {section === 'accounts' && (
        <Card title="现有配置" icon={<User size={15} strokeWidth={1.8} />}>
          {accountList.length === 0 ? (
            <div className="weq-set-empty">
              {accounts.isLoading ? <LoadingIndicator /> : '暂无保存的账号配置'}
            </div>
          ) : (
            <div className="weq-set-accounts">
              {accountList.map((acc) => {
                const isAutoEnter = autoEnterTarget?.configId === acc.configId;
                const currentConfigId = currentConfig.data?.configId ?? null;
                const isCurrent = currentConfigId
                  ? acc.configId === currentConfigId
                  : !!openedUin && acc.uin === openedUin;
                return (
                  <div key={acc.configId} className="weq-set-account-item">
                    <QqAvatar uin={acc.uin} size={40} className="weq-set-account-avatar" />
                    <div className="weq-set-account-info">
                      <span className="weq-set-account-name">
                        <span data-privacy-sensitive>{acc.displayName || acc.uin}</span>
                        {acc.static ? (
                          <span className="weq-set-badge">
                            {acc.mobile ? '手机备份' : '静态账号'}
                          </span>
                        ) : null}
                        {isAutoEnter ? (
                          <span className="weq-set-badge weq-set-badge-ok">默认进入</span>
                        ) : null}
                        {isCurrent ? (
                          <span className="weq-set-badge weq-set-badge-ok">当前账号</span>
                        ) : null}
                      </span>
                      <span className="weq-set-account-uin weq-number">QQ {acc.uin}</span>
                      {acc.dataDir ? (
                        <span className="weq-set-account-dir" title={acc.dataDir}>
                          {acc.dataDir}
                        </span>
                      ) : null}
                    </div>
                    {isAutoEnter ? (
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                        onClick={() => void onClearAutoEnter()}
                        disabled={clearAutoEnter.isLoading}
                        title="下次打开 WeQ 不再自动进入该账号"
                      >
                        <RotateCcw size={12} strokeWidth={1.8} aria-hidden />
                        取消默认进入
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                        onClick={() => void onSetAutoEnter(acc.uin, acc.dataDir)}
                        disabled={setAutoEnter.isLoading}
                      >
                        <User size={12} strokeWidth={1.8} aria-hidden />
                        设为默认
                      </button>
                    )}
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft weq-set-btn-sm weq-set-btn-del"
                      onClick={() => void onDeleteAccount(acc)}
                      disabled={deleteAccount.isLoading || isCurrent}
                      title={
                        isCurrent ? '当前已登录的账号无法删除，请先退出登录' : '删除该账号配置'
                      }
                    >
                      <Trash2 size={12} strokeWidth={1.8} aria-hidden />
                      删除
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <p className="weq-set-note">
            已保存的账号配置，点击「设为默认」后下次打开 WeQ 将自动进入该账号；想改回手动选择，
            对已默认的账号点击「取消默认进入」即可。「删除」只移除 WeQ 侧保存的配置，不影响 QQ
            本体数据。
          </p>
          {autoEnterTarget ? (
            <div className="weq-set-actions">
              <button
                data-danger="outline"
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                onClick={() => void onClearAutoEnter()}
                disabled={clearAutoEnter.isLoading}
              >
                <RotateCcw size={14} strokeWidth={1.8} aria-hidden />
                清除默认进入账号
              </button>
            </div>
          ) : null}
        </Card>
      )}

      {section === 'network' && (
        <Card title="加载来源" icon={<Cloud size={15} strokeWidth={1.8} />} settingId="prefer-cdn">
          <Row
            label="优先直连 QQ 加载图片"
            desc={
              preferCdn
                ? '桌面端与 Web 共用，不影响 Remote。优先向 QQ 加载头像、图片和视频封面，失败时回退。'
                : '桌面端与 Web 共用，不影响 Remote。优先读取电脑缓存，缺失时代取并缓存。'
            }
            control={
              <Toggle
                checked={preferCdn}
                disabled={settings.isLoading || setPreferCdnMut.isLoading}
                onChange={(next) => void onSetPreferCdn(next)}
                label="优先直连 QQ 加载图片"
              />
            }
          />
          <Row
            settingId="prefer-remote-cdn"
            label="Remote 缺少资源时优先直取"
            desc="手机没有缓存时，优先从 QQ 加载头像、聊天缩略图和支持的个性装扮，失败再由电脑加载。需要新版 Remote。"
            control={
              <Toggle
                checked={preferRemoteCdn}
                disabled={settings.isLoading || setPreferCdnMut.isLoading}
                onChange={(next) => void onSetPreferCdn(next, true)}
                label="Remote 缺少资源时优先直取"
              />
            }
          />
        </Card>
      )}
      {section === 'network' && (
        <Card resetId="chat-image-preview" icon={<ImageIcon size={15} strokeWidth={1.8} />}>
          <Row
            settingId="auto-download-preview-original"
            desc="省流量模式未生效时，打开聊天图片会自动下载缺失的原图。"
            control={
              <SharedDisplayToggle
                name="autoDownloadPreviewOriginal"
                label="预览时自动获取原图"
                fallback={false}
              />
            }
          />
        </Card>
      )}
      {section === 'network' && (
        <Card title="QQ 秀缓存" icon={<Shirt size={15} strokeWidth={1.8} />} resetId="qqshow-cache">
          <QqShowSettings cacheOnly />
        </Card>
      )}
      {section === 'network' && (
        <Card resetId="chat-memory" icon={<ImageIcon size={15} strokeWidth={1.8} />}>
          <ChatImageCacheSettings embedded />
          <ChatMessagePrewarmSettings />
        </Card>
      )}
      {/* WeQ 存储管理 */}
      {section === 'storage' && (
        <Card
          title="空间清理"
          icon={<Trash2 size={15} strokeWidth={1.8} />}
          settingId="weq-space-cleanup"
        >
          <div className="weq-set-actions weq-storage-toolbar">
            <span className="weq-set-cache-total">
              本页占用 <strong className="weq-number">{formatBytes(totalCacheBytes)}</strong>
              {' · '}可清理{' '}
              <strong className="weq-number">{formatBytes(availableCleanupBytes)}</strong>
              {' · '}可重新生成的缓存{' '}
              <strong className="weq-number">{formatBytes(clearableBytes)}</strong>
              {cacheItems.some((item) => item.incomplete) ? '（统计不完整）' : ''}
            </span>
            <div className="weq-set-btn-group weq-storage-toolbar-buttons">
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                title="刷新存储占用"
                aria-label="刷新存储占用"
                disabled={cacheUsage.isFetching || cleanupBusy}
                onClick={() => void cacheUsage.refetch()}
              >
                <RotateCcw size={14} aria-hidden />
                刷新占用
              </button>
            </div>
          </div>
          {restartIds.length > 0 && (
            <button
              data-danger="solid"
              type="button"
              className="weq-set-btn"
              disabled={cleanupBusy}
              onClick={() => {
                setCleaning(true);
                void retryOccupiedStorage(restartIds)
                  .catch((error) => showError('继续清除失败', errMsg(error)))
                  .finally(() => setCleaning(false));
              }}
            >
              <RotateCcw size={14} />
              重启并清除剩余项目
            </button>
          )}
          <div className="weq-set-cache-list" {...cacheMulti.rootProps}>
            {cacheUsage.isLoading ? (
              <div className="weq-set-empty" role="status">
                读取存储占用中…
              </div>
            ) : cacheUsage.isError ? (
              <div className="weq-set-empty" role="alert">
                读取存储占用失败：{errMsg(cacheUsage.error)}
              </div>
            ) : storageGroups.length === 0 ? (
              <div className="weq-set-empty">暂无存储数据</div>
            ) : (
              storageGroups.map(({ id, label, bytes, incomplete, entries }) => {
                const headingId = `${storageHeadingId}-${id}`;
                const panelId = `${headingId}-items`;
                const expanded = expandedStorageGroups.has(id);
                const pickedCount = expanded
                  ? 0
                  : entries.filter(({ item }) => pickedCats.has(item.id)).length;
                return (
                  <section key={id} className="weq-storage-group" aria-labelledby={headingId}>
                    <h4 id={headingId} className="weq-storage-group-heading">
                      <button
                        type="button"
                        className="weq-storage-group-toggle"
                        aria-expanded={expanded}
                        aria-controls={panelId}
                        onClick={() =>
                          setExpandedStorageGroups((previous) => {
                            const next = new Set(previous);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                      >
                        <ChevronRight className="weq-storage-group-chevron" size={14} aria-hidden />
                        <span>
                          {label}
                          {pickedCount > 0 ? (
                            <small>
                              <NumericText>{` · 已选 ${pickedCount} 项`}</NumericText>
                            </small>
                          ) : null}
                        </span>
                        <span className="weq-storage-group-size">
                          {incomplete ? '至少 ' : ''}
                          <NumericText>{formatBytes(bytes)}</NumericText>
                        </span>
                      </button>
                    </h4>
                    <div id={panelId} hidden={!expanded}>
                      {expanded && entries.map(({ item, members }) => storageItem(item, members))}
                    </div>
                  </section>
                );
              })
            )}
          </div>
          <div className="weq-set-actions">
            {pickedCats.size > 0 && (
              <span className="weq-set-cache-total" role="status">
                <NumericText>
                  {`已选可清理 ${formatBytes(cleanupBytes)}${selectedUnavailable > 0 ? ` · ${selectedUnavailable} 项当前无法清理` : ''}`}
                </NumericText>
              </span>
            )}
            <button
              type="button"
              className="weq-set-btn weq-set-btn-danger"
              disabled={selectionDisabled || cacheUsage.isError || cleanupBytes === 0}
              onClick={() => void onClearWeqCache()}
              data-danger={cleanupDanger}
            >
              {cleanupBusy ? (
                <Loader2 size={14} strokeWidth={1.8} className="weq-spin" aria-hidden />
              ) : (
                <Trash2 size={14} strokeWidth={1.8} aria-hidden />
              )}
              开始清理
            </button>
          </div>
        </Card>
      )}

      {section === 'logs' && <LogFileSettings />}
    </div>
  );
}
import { formatBytes } from '../../lib/format';
import { LogFileSettings } from './LogFileSettings';
