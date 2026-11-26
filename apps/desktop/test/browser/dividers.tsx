import { createRoot } from 'react-dom/client';
import { Copy, Pin, Search } from 'lucide-react';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-responsive.css';
import '../../src/renderer/src/styles/contact-workspace.css';
import '../../src/renderer/src/styles/conversation-actions.css';
import '../../src/renderer/src/styles/message-context-menu.css';
import '../../src/renderer/src/styles/cache.css';
import '../../src/renderer/src/styles/export.css';
import '../../src/renderer/src/styles/roaming-backfill.css';
import '../../src/renderer/src/styles/qzone.css';
import '../../src/renderer/src/styles/qzone-actions.css';
import '../../src/renderer/src/styles/long-tasks.css';
import '../../src/renderer/src/components/relationGraph/relationGraph.css';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';

ensureThemeInitialized();
Object.assign(window, { dividerQa: useThemeStore });

const samples = [
  ['weq-welcome-scan-toggle', 'top', '欢迎页'],
  ['weq-acct-new', 'top', '账号菜单'],
  ['weq-set-server-form-wrap', 'top', '服务配置'],
  ['weq-bot-block', 'top', '机器人配置'],
  ['weq-full-function-section', 'top', '在线能力分区'],
  ['weq-forward-preview-foot', 'top', '转发预览'],
  ['weq-ark-footer', 'top', '分享卡片'],
  ['weq-dynamic-footer', 'top', '动态卡片'],
  ['weq-flash-share-head', 'bottom', '闪传标题'],
  ['weq-forward-header', 'bottom', '聊天记录标题'],
  ['weq-cache-panel-head', 'bottom', '数据库浏览'],
  ['weq-cache-data-bar', 'bottom', '数据工具栏'],
  ['weq-cache-sql-editor', 'bottom', 'SQL 编辑器'],
  ['weq-cache-sql-notice', 'bottom', 'SQL 结果'],
  ['weq-cache-sql-indices', 'bottom', '数据库索引'],
  ['weq-cache-pager', 'top', '资源分页'],
  ['weq-cache-avatar-tabs', 'bottom', '头像资源'],
  ['weq-cache-sysemoji-bar', 'bottom', '系统表情'],
  ['weq-cache-marketemoji-bar', 'bottom', '商城表情'],
  ['weq-blob-head', 'bottom', '数据详情'],
  ['weq-blob-foot', 'top', '数据操作'],
  ['weq-mpack-bar', 'bottom', '表情包列表'],
  ['weq-mpack-detail-head', 'bottom', '表情包详情'],
  ['weq-filebrowser-toolbar', 'bottom', '文件资源'],
  ['weq-exp-pane-head', 'bottom', '导出面板'],
  ['weq-exp-pane-foot', 'top', '导出操作'],
  ['weq-exp-dialog-head', 'bottom', '导出详情标题'],
  ['weq-exp-dialog-foot', 'top', '导出详情操作'],
  ['weq-exp-cats', 'bottom', '导出分类'],
  ['weq-emb-detail-head', 'bottom', '表情导出'],
  ['weq-epk-stage', 'top', '表情预览'],
  ['weq-epk-actions', 'top', '表情操作'],
  ['weq-roaming-actions', 'top', '漫游操作'],
  ['weq-roaming-receipts', 'top', '漫游请求记录'],
  ['weq-merged-popover-header', 'bottom', '合并会话'],
  ['weq-ark-feed-header', 'bottom', '订阅内容'],
  ['weq-mf-nested-bar', 'bottom', '嵌套聊天记录'],
  ['group-keyword-editor-panel', 'top', '提醒词编辑'],
  ['emoji-panel-header', 'bottom', '表情面板标题栏'],
  ['ai-voice-head', 'bottom', '语音面板'],
  ['reaction-picker-head', 'bottom', '回应面板'],
  ['sidebar-header', 'bottom', '侧栏标题'],
  ['tools-detail-fields', 'top', '工具详情'],
  ['tools-row', 'bottom', '工具列表'],
  ['weq-grouppick-head', 'bottom', '关系图选群标题'],
  ['weq-grouppick-foot', 'top', '关系图选群操作'],
  ['weq-rank-head', 'bottom', '关系排行标题'],
  ['weq-rank-foot', 'top', '关系排行操作'],
  ['weq-editor-header', 'bottom', '消息编辑标题'],
  ['weq-editor-tabs', 'bottom', '消息编辑分类'],
  ['weq-editor-footer', 'top', '消息编辑操作'],
  ['reaction-likers-head', 'bottom', '回应成员标题'],
  ['reaction-likers-foot', 'top', '回应成员操作'],
  ['weq-long-task-detail', 'bottom', '任务详情'],
] as const;

createRoot(document.getElementById('root')!).render(
  <>
    <style>{`
      html,body,#root{margin:0;min-height:100%;height:auto;overflow:auto}
      body{background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
      .qa-root{max-width:980px;margin:auto;padding:20px;display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
      h1{font-size:20px;margin:0}h2{font-size:14px;margin:0 0 12px}
      .qa-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:24px;min-width:0}
      .qa-columns>section{min-width:0}
      .qa-menu{position:static;transform:none;width:100%;max-width:100%;height:auto;display:grid;box-sizing:border-box}
      .qa-samples{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:16px}
      .qa-sample{position:static;display:block;width:auto;min-width:0;max-width:100%;min-height:0;height:auto;margin:0;padding:10px;overflow-wrap:anywhere;box-sizing:border-box}
      .qa-reference{border-top:1px solid var(--weq-border-subtle)}
    `}</style>
    <main className="qa-root">
      <h1>分割线</h1>
      <div className="qa-reference" aria-hidden />
      <div className="qa-columns">
        <section className="weq-set">
          <h2>设置</h2>
          <details className="weq-set-details" data-divider-edge="top">
            <summary>查看读取说明</summary>
            <p>保留本机设置和现有数据。</p>
          </details>
          <ul className="weq-set-ledger">
            <li>读取并发</li>
            <li data-divider-edge="top">缓存记录</li>
          </ul>
          <div className="weq-set-confirm" data-temporary>
            <span>确认清除当前记录？</span>
            <button type="button" className="weq-set-btn">
              取消
            </button>
          </div>
        </section>
        <section>
          <h2>菜单</h2>
          <div className="message-context-menu message-menu-v2 qa-menu">
            <div className="message-menu-group">
              <button type="button">
                <Copy size={16} />
                <span>复制消息</span>
              </button>
            </div>
            <div className="message-menu-group" data-divider-edge="top">
              <button type="button">
                <Search size={16} />
                <span>定位到原消息</span>
              </button>
            </div>
            <div className="message-context-menu-separator" data-divider-fill />
            <button type="button">
              <Pin size={16} />
              <span>设为重要消息</span>
            </button>
          </div>
          <div className="weq-conversation-actions-menu qa-menu">
            <button type="button">打开会话</button>
            <button type="button" className="has-separator" data-divider-edge="top">
              会话设置
            </button>
          </div>
          <div className="weq-flash-divider" data-divider-fill />
          <div className="weq-persona-divider" data-divider-fill />
          <div className="weq-contact-profile-v2">
            <div className="weq-profile-section-block--prominent" data-divider-edge="top">
              资料
            </div>
          </div>
        </section>
      </div>
      <section>
        <h2>内容分区</h2>
        <div className="qa-samples">
          {samples.map(([className, edge, label]) => (
            <div key={className} className={`${className} qa-sample`} data-divider-edge={edge}>
              {label}
            </div>
          ))}
          <div aria-hidden />
        </div>
      </section>
      <table className="weq-cache-grid">
        <tbody>
          <tr>
            <th data-divider-edge="bottom">数据库字段</th>
            <td data-divider-edge="right">昵称</td>
          </tr>
        </tbody>
      </table>
      <div className="weq-voice-monthsep" data-month-label>
        <span>2026 年 11 月</span>
      </div>
      <div className="message-time-divider" data-time-label>
        11 月 17 日
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 4px', height: 16 }}>
        <div className="sidebar-resize" role="separator" aria-label="调整侧栏宽度" />
      </div>
      <div className="weq-transfer-card">
        <div className="weq-transfer-footer" data-wallet>
          转账
        </div>
      </div>
    </main>
  </>,
);
