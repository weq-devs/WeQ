import { useState } from 'react';
import { ChevronDown, RefreshCw, Zap } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { IS_WEB } from '../../lib/target';
import { QqDebugCopy } from '../QqDebugCopy';
import '../../styles/settings-full-functions.css';

const FEATURES = [
  ['本地记录', '浏览、搜索、统计与导出', '保留全部本地能力'],
  ['实时监听', '监听本地数据库中的新消息、撤回与表情回应', '继续使用本地监听'],
  ['漫游消息', '无法主动拉取', '从 QQ 补充本地缺失的历史记录'],
  ['发送与互动', '无法执行在线操作', '发送消息、群操作与管理、按设置上报已读'],
  ['在线内容', '依赖 QQ 会话的内容暂不可用', '空间、群相册、收藏、邮箱与装扮等在线内容'],
  ['缺失媒体', '使用已有缓存和可用下载链路', '增加当前 QQ 会话的取票、链接更新与媒体补全'],
] as const;

/** 只说明能力与读取路线，不用授权助手或自动策略冒充账号就绪状态。 */
export function FullFunctionSetup({ isMac }: { isMac: boolean }) {
  const [debugOpen, setDebugOpen] = useState(false);
  const autoRefresh = useQQAutoRefresh(isMac);
  const sip = trpc.bootstrap.sipEnabled.useQuery(undefined, autoRefresh);
  return (
    <>
      <section className="weq-full-function-section" data-setting-id="full-features">
        <h4 className="weq-full-function-heading">
          <Zap size={15} strokeWidth={1.8} aria-hidden />
          完整功能
        </h4>
        <p className="weq-full-function-description">
          在本地记录查看与导出的基础上，启用当前账号的 QQ 在线能力。
        </p>
        <table className="weq-full-function-comparison" aria-label="受限模式与完整功能对照">
          <thead>
            <tr>
              <th scope="col">功能</th>
              <th scope="col">受限模式</th>
              <th scope="col">完整功能</th>
            </tr>
          </thead>
          <tbody>
            {FEATURES.map(([feature, restricted, full]) => (
              <tr key={feature}>
                <th scope="row">{feature}</th>
                <td>{restricted}</td>
                <td>{full}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="weq-full-function-description">
          本地能力以数据库可读取为前提；受限模式不等于完全离线，已有媒体链接、外部 rKey
          等可用下载方式仍会保留。在线操作需当前账号登录、凭据与在线会话就绪。
        </p>
      </section>
      <section className="weq-full-function-section" data-setting-id="full-feature-routes">
        <h4 className="weq-full-function-heading">启用方式</h4>
        {isMac ? (
          <>
            <p className="weq-full-function-description">
              两条路线用于获得相同的在线能力，按本机环境使用，不需要依次完成。
            </p>
            <div className="weq-full-function-system">
              <span role="status">
                {sip.data === true
                  ? '当前系统：SIP 已开启'
                  : sip.data === false
                    ? '当前系统：SIP 已关闭'
                    : sip.error
                      ? 'SIP 状态检测失败'
                      : 'SIP 状态待检测'}
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
            <section className="weq-full-function-route" data-setting-id="qq-debug-copy">
              <h5>QQ 调试副本 · 保持 SIP 开启</h5>
              {IS_WEB ? (
                <p className="weq-full-function-description">
                  请在运行 QQ 的 Mac 上打开 WeQ 桌面端，准备并启动调试副本，再登录当前账号。
                </p>
              ) : (
                <>
                  <p className="weq-full-function-description">
                    使用可调试的 QQ
                    副本，保留原安装，与原版共用账号和聊天数据。准备并启动副本后，在副本中登录当前账号。
                  </p>
                  <details
                    className="weq-set-details"
                    onToggle={(event) => setDebugOpen(event.currentTarget.open)}
                  >
                    <summary>
                      <ChevronDown size={13} aria-hidden />
                      副本状态与管理
                    </summary>
                    {debugOpen ? <QqDebugCopy /> : null}
                  </details>
                </>
              )}
            </section>
            <section className="weq-full-function-route">
              <h5>原版 QQ · 适用于 SIP 已关闭的环境</h5>
              <p className="weq-full-function-description">
                继续使用原安装，无需创建副本。在原版 QQ 登录当前账号后，WeQ
                尝试读取会话凭据，必要时请求管理员授权。
              </p>
              <p className="weq-full-function-description">
                长期授权可减少重复授权，但不能替代 SIP 或调试签名条件。
              </p>
            </section>
          </>
        ) : (
          <p className="weq-full-function-description">
            在运行 WeQ 宿主的电脑上登录当前 QQ 账号，由 WeQ
            读取会话凭据；需要管理员权限时会提示授权，也可使用下方的长期授权助手。
          </p>
        )}
        <p className="weq-full-function-description">
          QQ
          已启动、调试副本已就绪或权限助手已连接，都不等于完整功能已启用。关闭自动启用时，可从标题栏的「受限模式」详情为当前来源手动启用。
        </p>
      </section>
    </>
  );
}
