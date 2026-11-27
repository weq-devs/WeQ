import { useId, useState } from 'react';
import { ChevronDown, Database, Eye, Network, Zap } from 'lucide-react';
import {
  QQ_CAPABILITY_MODES,
  QQ_CAPABILITY_MODE_LABELS,
  qqCapabilityAllowsOnline,
  type QqCapabilityMode,
} from '@weq/service/qq-capability-mode';
import { trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { useRestrictedMode } from '../../state/restrictedMode';
import { restrictionReasons } from '../../lib/restrictedMode';
import { IS_WEB } from '../../lib/target.shared';
import { AnimatedDetails } from '../AnimatedDetails';
import { useDialog } from '../Dialog.shared';
import { LongTermAuthorizationLink } from '../LongTermAuthorizationLink';
import { QqDebugCopyDialog } from '../QqDebugCopyDialog';
import { QqProxyRecovery } from '../QqProxyConnection';
import { isQqProxyWaiting, qqProxySetupGuide, QQ_PROXY_WAITING } from '../QqProxyConnection.shared';
import { AuthorizationForm } from '../RestrictedMode';
import { RestrictedQqAction } from '../RestrictedQqAction';
import { useTabActive } from '../RetainedTabs.shared';
import { Card, Row, SettingsStatusBadge } from './controls';

const icons = { 'read-only': Eye, local: Database, online: Zap, complete: Network };
const descriptions: Record<QqCapabilityMode, string> = {
  'read-only': '浏览、搜索和导出聊天。阅读保留未读角标，无法编辑或删除 QQ 消息。',
  local: '阅读可更新未读角标。可手动标记已读或未读，也可编辑、删除本地 QQ 消息。',
  online:
    '可发送消息、拉取漫游等。接收新消息可能有延迟，发出的消息不会自动显示在本机 QQ，阅读也不会自动清除本机 QQ 的未读角标。',
  complete: '支持的消息可更快显示。发出的消息和已读状态会自动同步到本机 QQ。',
};

function useQqCapabilityStatus(onlineEnabled: boolean) {
  const active = useTabActive();
  const uin = useViewState((state) => (state.view === 'main' ? state.openedUin : null));
  const platform = trpc.bootstrap.systemInfo.useQuery(undefined, {
    enabled: active && onlineEnabled,
  });
  const mac = platform.data?.platformKind === 'darwin';
  const sip = trpc.bootstrap.sipEnabled.useQuery(undefined, {
    enabled: active && onlineEnabled && mac,
    retry: false,
  });
  const access = trpc.account.getGroupAlbumAccessState.useQuery(undefined, { enabled: false });
  const account = trpc.account.getAccountConfig.useQuery(undefined, { enabled: false });
  const config = account.data?.uin === uin ? account.data : undefined;
  const source = access.data?.source;
  const current =
    source?.expectedAccountUin === uin &&
    (!config || source.expectedAccountConfigId === config.configId)
      ? access.data
      : undefined;
  const snapshot = config?.static === true;
  const reasons = restrictionReasons({ access: current, sipEnabled: sip.data });
  const ready = Boolean(current?.qqOnline && reasons.length === 0);
  return { active, uin, mac, sip, current, snapshot, reasons, ready, accessError: access.isError };
}

export function QqCapabilitySetup({ mode }: { mode?: QqCapabilityMode }) {
  const confirm = useDialog((state) => state.confirm);
  const utils = trpc.useUtils();
  const id = useId();
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');
  const change = trpc.bootstrap.setQqCapabilityMode.useMutation();
  const onlineEnabled = mode !== undefined && qqCapabilityAllowsOnline(mode);
  const status = useQqCapabilityStatus(onlineEnabled);
  let statusNote: string | undefined;
  if (onlineEnabled) {
    if (status.snapshot) statusNote = '当前打开的是静态备份。打开本机 QQ 账号后可使用在线功能。';
    else if (status.ready) statusNote = '当前账号的 QQ 在线能力已就绪。';
    else if (status.uin && !status.current) {
      statusNote = status.accessError
        ? '暂时无法确认当前账号的 QQ 登录状态。'
        : '正在检查当前账号的 QQ 登录状态…';
    }
  }

  async function select(next: QqCapabilityMode, retry = false) {
    if (!mode || changing || (mode === next && !retry)) return;
    setChanging(true);
    setError('');
    try {
      let result = await change.mutateAsync({ mode: next });
      if (result.status === 'confirm-disconnect') {
        const accepted = await confirm(
          '关闭 QQ 代理',
          '关闭后，正在使用代理的 QQ 连接会断开。请先在 QQ 登录窗口的「网络设置」中恢复直连。',
          { okLabel: '关闭代理' },
        );
        if (!accepted) return;
        result = await change.mutateAsync({ mode: next, disconnectProxy: true });
      }
      if (result.status === 'saved' && result.proxyError) setError(result.proxyError);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      await Promise.all([
        utils.bootstrap.getSettings.invalidate(),
        utils.bootstrap.getFullModeState.invalidate(),
        utils.account.getGroupAlbumAccessState.invalidate(),
        utils.bootstrap.getQqClientSyncStatus.invalidate(),
      ]);
      setChanging(false);
    }
  }

  return (
    <>
      <Card title="QQ 能力档位" settingId="full-features" resetId="attach">
        <div
          className="weq-applock-methods"
          role="radiogroup"
          aria-label="QQ 能力档位"
          data-setting-id="auto-full-mode"
        >
          {QQ_CAPABILITY_MODES.map((option, index) => {
            const Icon = icons[option];
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={mode === option}
                aria-labelledby={`${id}-${option}`}
                aria-describedby={`${id}-${option}-desc`}
                tabIndex={mode === option ? 0 : -1}
                aria-disabled={!mode || changing}
                className={`weq-applock-method${mode === option ? ' is-active' : ''}`}
                onClick={() => void select(option)}
                onKeyDown={(event) => {
                  const delta =
                    event.key === 'ArrowDown' || event.key === 'ArrowRight'
                      ? 1
                      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                        ? -1
                        : 0;
                  if (!delta || changing) return;
                  event.preventDefault();
                  const target =
                    QQ_CAPABILITY_MODES[
                      (index + delta + QQ_CAPABILITY_MODES.length) % QQ_CAPABILITY_MODES.length
                    ];
                  if (!target) return;
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLButtonElement>(`[value="${target}"]`)
                    ?.focus();
                  void select(target);
                }}
                value={option}
              >
                <span className="weq-applock-method-icon">
                  <Icon size={18} strokeWidth={1.8} aria-hidden />
                </span>
                <span className="weq-applock-method-main">
                  <strong id={`${id}-${option}`}>{QQ_CAPABILITY_MODE_LABELS[option]}</strong>
                  <small id={`${id}-${option}-desc`}>{descriptions[option]}</small>
                </span>
              </button>
            );
          })}
        </div>
        {changing && (
          <p className="weq-set-note" role="status">
            正在切换 QQ 能力档位…
          </p>
        )}
        {error && (
          <p className="weq-set-note weq-set-note-warn" role="alert">
            {error}
          </p>
        )}
        {statusNote && (
          <p className="weq-set-note" role={status.snapshot ? undefined : 'status'}>
            {statusNote}
          </p>
        )}
      </Card>
      {onlineEnabled && !status.snapshot && (
        <QqCapabilityActions
          status={status}
          complete={mode === 'complete'}
          changing={changing}
          retryProxy={() => select('complete', true)}
        />
      )}
    </>
  );
}

function QqCapabilityActions({
  status,
  complete,
  changing,
  retryProxy,
}: {
  status: ReturnType<typeof useQqCapabilityStatus>;
  complete: boolean;
  changing: boolean;
  retryProxy: () => Promise<void>;
}) {
  const { active, uin, mac, sip, current, reasons, ready } = status;
  const utils = trpc.useUtils();
  const install = trpc.bootstrap.describeInstall.useQuery(undefined, {
    enabled: active,
    retry: false,
  });
  const auth = useRestrictedMode((state) => state.requests[0]);
  const credentials = reasons.find(
    ({ code }) => code === 'credentials' || code === 'authorization',
  );
  const missingInstall = install.data?.hasQqExe === false && !current?.qqOnline;
  const needsCopy =
    mac &&
    sip.data === true &&
    !ready &&
    (!current?.qqOnline || reasons.some(({ code }) => code === 'sip'));
  const [debugOpen, setDebugOpen] = useState(false);
  const [chosenOriginal, setChosenOriginal] = useState(false);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const proxy = trpc.bootstrap.getQqClientSyncStatus.useQuery(undefined, {
    enabled: active && complete,
    staleTime: 0,
    refetchInterval: active && complete ? 5000 : false,
  });
  const hostProxy = proxy.data;
  const proxyWaiting = isQqProxyWaiting(hostProxy, current, uin);
  const needsLogin = !current?.qqOnline && (!uin || current !== undefined);
  const showMacChoice = mac && sip.data === false;
  const refresh = async () => {
    await Promise.all([
      utils.account.getGroupAlbumAccessState.invalidate(),
      utils.bootstrap.getQqClientSyncStatus.invalidate(),
    ]);
  };
  const launch = trpc.bootstrap.launchQq.useMutation({ onSettled: refresh });
  const retryCredentials = trpc.account.refreshRkeys.useMutation({ onSettled: refresh });
  const copy = trpc.bootstrap.qqDebugCopyAction.useMutation({ onSettled: refresh });
  const savePort = trpc.bootstrap.setQqClientSyncPort.useMutation({
    onSuccess: async () => {
      setPortDraft(null);
      await proxy.refetch();
    },
  });
  const port = Number(portDraft);
  const canSavePort =
    hostProxy && Number.isInteger(port) && port > 0 && port <= 65535 && port !== hostProxy.port;

  const clientChoices = (
    <>
      <p className="weq-set-note">
        原版 QQ
        可继续使用现有安装，读取会话时可能需要管理员授权。调试副本在调试权限就绪后可直接读取。
      </p>
      <div className="weq-restricted-actions">
        <button
          type="button"
          className="weq-set-btn"
          disabled={launch.isPending || copy.isPending}
          onClick={() => {
            copy.reset();
            setChosenOriginal(true);
            launch.mutate({ newInstance: needsLogin, original: true });
          }}
        >
          使用原版 QQ
        </button>
        {!IS_WEB && (
          <>
            <button
              type="button"
              className="weq-set-btn"
              disabled={launch.isPending || copy.isPending}
              onClick={() => {
                launch.reset();
                setChosenOriginal(false);
                copy.mutate({ action: 'open' });
              }}
            >
              使用调试副本
            </button>
            <button type="button" className="weq-set-btn" onClick={() => setDebugOpen(true)}>
              副本设置
            </button>
          </>
        )}
      </div>
      {IS_WEB && <p className="weq-set-note">调试副本在运行 QQ 的 Mac 上用 WeQ 桌面端管理。</p>}
      {(launch.error || copy.error) && <p role="alert">{(launch.error ?? copy.error)?.message}</p>}
    </>
  );

  return (
    <>
      {(missingInstall || needsCopy || showMacChoice || (mac && sip.isError)) && (
        <Card title="准备本机 QQ" settingId="full-feature-routes">
          {missingInstall ? (
            <Row
              label="未检测到 QQ 安装"
              desc="请在运行 WeQ 的电脑上安装 QQ，完成后重新检查。"
              control={
                <button
                  type="button"
                  className="weq-set-btn"
                  onClick={() => void install.refetch()}
                >
                  重新检查
                </button>
              }
            />
          ) : needsCopy ? (
            <div data-setting-id="qq-debug-copy">
              <p className="weq-set-note">
                本机 SIP 已开启。请使用 QQ 调试副本。原版 QQ 需要在 SIP 已关闭时才能读取会话。
              </p>
              {complete && needsLogin && hostProxy?.running && (
                <p className="weq-set-note">{qqProxySetupGuide(hostProxy.port)}</p>
              )}
              {IS_WEB ? (
                <p className="weq-set-note">
                  请在运行 QQ 的 Mac 上用 WeQ 桌面端准备调试副本，再登录 QQ。
                </p>
              ) : (
                <RestrictedQqAction
                  needsQq
                  busy={changing}
                  hasCurrentAccount={Boolean(uin)}
                  currentAccountPid={current?.qqPid}
                  onOpened={refresh}
                  onEnable={async () => {
                    await retryCredentials.mutateAsync(current?.source);
                  }}
                />
              )}
            </div>
          ) : showMacChoice ? (
            <div data-setting-id="qq-debug-copy">
              {ready ? (
                <AnimatedDetails className="weq-set-inline-details">
                  <summary>
                    <ChevronDown size={14} aria-hidden />
                    更换所用的 QQ
                  </summary>
                  {clientChoices}
                </AnimatedDetails>
              ) : (
                clientChoices
              )}
            </div>
          ) : (
            <Row
              label="暂时无法确认本机 QQ 读取条件"
              control={
                <button type="button" className="weq-set-btn" onClick={() => void sip.refetch()}>
                  重新检查
                </button>
              }
            />
          )}
        </Card>
      )}
      {needsLogin && !missingInstall && !needsCopy && (
        <Card
          title={uin ? '登录当前账号' : '登录 QQ'}
          desc={
            uin
              ? '在本机 QQ 登录当前账号后，WeQ 会继续准备在线功能。'
              : '请在本机 QQ 登录要使用的账号。'
          }
        >
          {complete && hostProxy?.running && (
            <p className="weq-set-note">{qqProxySetupGuide(hostProxy.port)}</p>
          )}
          <QqProxyRecovery
            needsCurrentLogin={Boolean(uin)}
            onLaunch={() => void refresh()}
            original={chosenOriginal}
          />
        </Card>
      )}
      {!needsLogin &&
        !needsCopy &&
        !ready &&
        (credentials || auth || current?.credentialsPending) && (
          <Card title="授权读取 QQ 会话">
            {auth ? (
              <AuthorizationForm key={auth.token} request={auth} />
            ) : (
              <>
                <p className="weq-set-note" role="status">
                  {credentials?.code === 'authorization'
                    ? credentials.guidance
                    : current?.credentialsPending || retryCredentials.isPending
                      ? '正在准备 QQ 在线能力…'
                      : credentials?.guidance}
                </p>
                {!current?.credentialsPending && (
                  <div className="weq-restricted-actions">
                    <button
                      type="button"
                      className="weq-set-btn"
                      disabled={retryCredentials.isPending}
                      onClick={() => retryCredentials.mutate(current?.source)}
                    >
                      重试获取在线凭据
                    </button>
                    <LongTermAuthorizationLink />
                  </div>
                )}
                {retryCredentials.error && <p role="alert">{retryCredentials.error.message}</p>}
              </>
            )}
          </Card>
        )}
      {complete && (
        <Card
          title="连接本机 QQ"
          settingId="qq-proxy-connection"
          icon={<Network size={15} aria-hidden />}
          titleBadge={
            <SettingsStatusBadge
              label={
                hostProxy?.connected
                  ? '已连接'
                  : hostProxy?.connecting
                    ? '正在确认连接'
                    : proxyWaiting
                      ? QQ_PROXY_WAITING
                      : hostProxy?.running
                        ? '未连接'
                        : hostProxy
                          ? '代理未运行'
                          : proxy.isError
                            ? '状态待确认'
                            : '检查中'
              }
              tone={hostProxy?.connected ? 'ready' : 'neutral'}
              loading={proxyWaiting || hostProxy?.connecting}
            />
          }
        >
          {hostProxy?.running && !hostProxy.connected && !needsLogin && (
            <>
              <p className="weq-set-note">{qqProxySetupGuide(hostProxy.port)}</p>
              <QqProxyRecovery
                needsCurrentLogin={false}
                onLaunch={() => void refresh()}
                original={chosenOriginal}
              />
            </>
          )}
          {hostProxy && !hostProxy.running && (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-primary"
              disabled={changing}
              onClick={() => void retryProxy()}
            >
              启动 QQ 代理
            </button>
          )}
          {proxy.isError && <p role="alert">无法读取代理状态。</p>}
          {(hostProxy?.error || savePort.error) && (
            <p role="alert">{savePort.error?.message ?? hostProxy?.error}</p>
          )}
          {hostProxy && (
            <Row
              label="代理端口"
              control={
                <form
                  className="weq-set-btn-group"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (canSavePort) savePort.mutate({ port });
                  }}
                >
                  <input
                    className="weq-set-input weq-set-input-sm weq-number"
                    aria-label="QQ 代理端口"
                    inputMode="numeric"
                    value={portDraft ?? hostProxy.port}
                    onChange={(event) =>
                      setPortDraft(event.target.value.replace(/\D/g, '').slice(0, 5))
                    }
                  />
                  <button
                    type="submit"
                    className="weq-set-btn"
                    disabled={!canSavePort || changing || savePort.isPending}
                  >
                    保存端口
                  </button>
                </form>
              }
            />
          )}
          {!!hostProxy?.tasks?.pending && (
            <p className="weq-set-note">待同步 {hostProxy.tasks.pending} 项。</p>
          )}
          {hostProxy?.connected && hostProxy.tasks?.error && (
            <p role="alert">{hostProxy.tasks.error}</p>
          )}
        </Card>
      )}
      {debugOpen && <QqDebugCopyDialog onClose={() => setDebugOpen(false)} />}
    </>
  );
}
