import { useState, type ReactNode } from 'react';
import { RefreshCw, Settings, Zap } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { IS_WEB } from '../../lib/target.shared';
import { QqDebugCopyDialog } from '../QqDebugCopyDialog';
import { QQ_STATUS_DETAILS_ID } from '../RestrictedMode.shared';
import { Card, SettingsStatusBadge } from './controls';
import { useViewState } from '../../state/view';
import { useRestrictedMode } from '../../state/restrictedMode';
import { restrictionReasons } from '../../lib/restrictedMode';
import '../../styles/settings-full-functions.css';

function OnlineCapabilityStatus() {
  const uin = useViewState((state) => state.openedUin);
  const requests = useRestrictedMode((state) => state.requests.length);
  const entering = useRestrictedMode((state) => state.enteringSince !== null);
  const authorizationIssue = useRestrictedMode((state) =>
    state.reasons.some((reason) => reason.code === 'authorization'),
  );
  const open = useRestrictedMode((state) => state.settingsSection === 'online');
  const access = trpc.account.getGroupAlbumAccessState.useQuery(
    undefined,
    useQQAutoRefresh(Boolean(uin)),
  );
  const currentAccess =
    access.data?.source && access.data.source.expectedAccountUin !== uin ? undefined : access.data;
  const label = requests
    ? '等待授权'
    : entering && !authorizationIssue
      ? '正在启用'
      : !uin
        ? '未打开账号'
        : access.isError
          ? '状态待确认'
          : !currentAccess
            ? '检查中'
            : !currentAccess.attachEnabled
              ? '已关闭'
              : restrictionReasons({ access: currentAccess }).length
                ? '在线能力受限'
                : '已就绪';
  if (label === '已就绪' && !open) return <SettingsStatusBadge label={label} tone="ready" />;
  const tone =
    label === '在线能力受限' || label === '等待授权' || label === '状态待确认'
      ? 'warning'
      : label === '已就绪'
        ? 'ready'
        : 'neutral';
  return (
    <SettingsStatusBadge
      label={label}
      tone={tone}
      details={{
        label: `QQ 在线能力：${label}，查看详情`,
        open,
        controls: open ? QQ_STATUS_DETAILS_ID : undefined,
        onClick: () => useRestrictedMode.getState().setOpen(!open, 'online'),
      }}
    />
  );
}

/** 集中展示真实能力状态与读取路线，不用自动策略冒充账号就绪状态。 */
export function FullFunctionSetup({
  isMac,
  enableSetting,
}: {
  isMac: boolean;
  enableSetting: ReactNode;
}) {
  const [debugOpen, setDebugOpen] = useState(false);
  const autoRefresh = useQQAutoRefresh(isMac);
  const sip = trpc.bootstrap.sipEnabled.useQuery(undefined, autoRefresh);
  const applicable = sip.error
    ? null
    : sip.data === true
      ? 'copy'
      : sip.data === false
        ? 'original'
        : null;
  return (
    <>
      <Card
        title="在线能力"
        titleBadge={<OnlineCapabilityStatus />}
        icon={<Zap size={15} strokeWidth={1.8} />}
        desc="使用当前 QQ 会话发送消息、拉取漫游和查看在线内容。"
        settingId="full-features"
        resetId="attach"
      >
        {enableSetting}
        <section className="weq-full-function-section" data-setting-id="full-feature-routes">
          <h4 className="weq-set-subheading">{isMac ? '启用方式（macOS）' : '启用方式'}</h4>
          {isMac && <p className="weq-set-note">以下两条路线任选其一，不需要同时配置。</p>}
          {isMac ? (
            <>
              {(sip.error || applicable === null) && (
                <div className="weq-full-function-system">
                  <span role="status" className="weq-set-row-desc">
                    {sip.error ? 'SIP 状态检测失败' : '正在确认适用于本机的路线…'}
                  </span>
                  {sip.error ? (
                    <button
                      type="button"
                      className="weq-set-iconbtn"
                      title="重新检测 SIP 状态"
                      aria-label="重新检测 SIP 状态"
                      disabled={sip.isFetching}
                      onClick={() => void sip.refetch()}
                    >
                      <RefreshCw size={14} aria-hidden />
                    </button>
                  ) : null}
                </div>
              )}
              <div className="weq-full-function-routes">
                <section
                  className="weq-full-function-route"
                  data-setting-id="qq-debug-copy"
                  aria-label="QQ 调试副本路线"
                  data-applicable={applicable === 'copy'}
                >
                  <header className="weq-full-function-route-heading">
                    <h5 className="weq-set-row-label">QQ 调试副本</h5>
                    <span className="weq-full-function-route-condition">
                      无需关闭 SIP{applicable === 'copy' ? '（适用于本机）' : ''}
                    </span>
                  </header>
                  <p className="weq-set-note">
                    {IS_WEB
                      ? '请在运行 QQ 的 Mac 上打开 WeQ 桌面端，准备并启动调试副本，再登录当前账号。'
                      : '使用可调试的 QQ 副本，保留原安装，与原版共用账号和聊天数据。准备并启动副本后，在副本中登录当前账号。'}
                  </p>
                  {!IS_WEB && (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      onClick={() => setDebugOpen(true)}
                    >
                      <Settings size={14} aria-hidden />
                      副本设置
                    </button>
                  )}
                </section>
                <section
                  className="weq-full-function-route"
                  aria-label="原版 QQ 路线"
                  data-applicable={applicable === 'original'}
                >
                  <header className="weq-full-function-route-heading">
                    <h5 className="weq-set-row-label">原版 QQ</h5>
                    <span className="weq-full-function-route-condition">
                      需关闭 SIP{applicable === 'original' ? '（适用于本机）' : ''}
                    </span>
                  </header>
                  <p className="weq-set-note">
                    继续使用原安装，无需创建副本。在原版 QQ 登录当前账号后，WeQ
                    尝试读取会话凭据，必要时请求管理员授权。
                  </p>
                  <p className="weq-set-note">
                    长期授权可减少重复授权，但不能替代 SIP 或调试签名条件。
                  </p>
                </section>
              </div>
            </>
          ) : (
            <p className="weq-set-note">
              在运行 WeQ 宿主的电脑上登录当前 QQ 账号，由 WeQ
              读取会话凭据；需要管理员权限时会提示授权，也可使用下方的长期授权助手。
            </p>
          )}
        </section>
      </Card>
      {debugOpen && <QqDebugCopyDialog onClose={() => setDebugOpen(false)} />}
    </>
  );
}
