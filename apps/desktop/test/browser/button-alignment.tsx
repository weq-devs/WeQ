import { createRoot } from 'react-dom/client';
import { Download, RefreshCw, Save, X } from 'lucide-react';
import { RelationGraphView } from '../../src/renderer/src/components/relationGraph/RelationGraphView';
import { SegmentedControl } from '../../src/renderer/src/components/SegmentedControl';
import { Card } from '../../src/renderer/src/components/settings/controls';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/qq-actions.css';
import '../../src/renderer/src/styles/export.css';
import '../../src/renderer/src/styles/dressup.css';
import '../../src/renderer/src/styles/decoration-save.css';
import '../../src/renderer/src/styles/mail.css';
import '../../src/renderer/src/styles/udp-capture.css';
import '../../src/renderer/src/styles/contact-card.css';
import '../../src/renderer/src/styles/contact-workspace.css';
import '../../src/renderer/src/styles/settings-database.css';
import '../../src/renderer/src/styles/message-calendar.css';
import '../../src/renderer/src/styles/export-viewer.css';
import '../../src/renderer/src/styles/chat-export-continuation.css';
import '../../src/renderer/src/styles/cache.css';
import '../../src/renderer/src/styles/group-bug.css';
import '../../src/renderer/src/styles/help-settings.css';
import '../../src/renderer/src/styles/model-settings.css';
import '../../src/renderer/src/styles/qzone.css';
import '../../src/renderer/src/styles/avatar-history.css';
import '../../src/renderer/src/styles/data-saver-menu.css';

ensureThemeInitialized();
Object.assign(window, { buttonAlignmentTheme: useThemeStore });

const samples = [
  ['设置操作', 'weq-set-actions', 'weq-set-btn', 'weq-set-btn weq-set-btn-primary'],
  ['设置按钮组', 'weq-set-btn-group', 'weq-set-btn', 'weq-set-btn'],
  ['紧凑按钮组', 'weq-set-btn-group', 'weq-set-btn weq-set-btn-sm', 'weq-set-btn weq-set-btn-sm'],
  ['QQ 操作', 'weq-qq-action-bar', 'weq-set-btn', 'weq-set-iconbtn'],
  ['确认对话框', 'weq-dialog-foot', 'weq-action-primary', 'weq-action-soft'],
  ['导出对话框', 'weq-exp-dialog-foot', 'weq-exp-btn is-primary', 'weq-exp-btn'],
  ['抓包工具栏', 'weq-cap-bar', 'weq-cap-btn', 'weq-cap-iconbtn'],
  ['UDP 工具栏', 'weq-udp-bar', 'weq-udp-btn', 'weq-udp-btn'],
  ['UDP 进程切换', 'weq-udp-picker-tabs', 'weq-udp-tab is-active', 'weq-udp-btn'],
  ['逆向工具', 'weq-wtools-rv-actions', 'weq-wtools-rv-primary', 'weq-wtools-rv-btn'],
  ['装扮操作', 'weq-dress-card-actions', 'weq-dress-use', 'weq-dress-save'],
  ['媒体保存', 'weq-save-action-group', 'weq-set-btn', 'weq-set-btn'],
  ['灯箱操作', 'weq-lightbox-actions', 'weq-lightbox-action', 'weq-lightbox-action'],
  ['邮箱工具栏', 'weq-mail-top-actions', 'weq-mail-primary', ''],
] as const;

const mixedSamples = [
  ['设置端口', 'weq-set-btn-group', 'weq-set-input weq-set-input-sm', 'weq-set-btn weq-set-btn-sm'],
  ['数据库并发', 'weq-database-read-controls', 'weq-set-input', 'weq-set-iconbtn'],
  ['头像路径', 'weq-avpath-form', 'weq-avpath-input', 'weq-action-primary weq-avpath-go'],
  ['增量导出路径', 'weq-export-baseline-root', '', 'weq-exp-tool'],
  ['导出记录日期', 'weq-ev-actions', '', ''],
  ['反馈标题', 'weq-help-bug-title-row', 'weq-help-bug-title', 'weq-set-btn weq-set-btn-sm'],
  ['群反馈标题', 'weq-group-bug-title-row', 'weq-group-bug-title', 'weq-group-bug-btn'],
  ['回退内容', 'weq-suggestion-fallback-row', 'weq-set-input', 'weq-set-iconbtn'],
  ['助手地址', 'weq-bot-urlrow', 'weq-set-input', 'weq-set-btn weq-set-btn-sm'],
  ['QQ 操作输入', 'weq-qq-action-bar', '', 'weq-set-iconbtn'],
] as const;

function Fixture() {
  return (
    <>
      <style>{`
        html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}
        main{max-width:1000px;margin:auto;padding:16px;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
        .alignment-graph{height:320px;display:flex;min-width:0}
        .alignment-samples{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:20px}
        .alignment-samples section{min-width:0}
        h2{font-size:13px;margin:0 0 8px}
        .alignment-column{width:160px}
        @media(max-width:650px){.alignment-samples{grid-template-columns:minmax(0,1fr)}}
      `}</style>
      <main>
        <div className="alignment-graph">
          <RelationGraphView />
        </div>
        <div className="alignment-samples weq-set">
          {samples.map(([label, parent, first, second]) => (
            <section
              key={label}
              className={label.startsWith('邮箱') ? 'weq-mail-workspace' : undefined}
            >
              <h2>{label}</h2>
              <div className={parent} data-alignment={label}>
                <button type="button" className={first}>
                  <Save size={14} />
                  保存
                </button>
                <button type="button" className={second} aria-label="取消">
                  <X size={14} />
                </button>
                <button type="button" className={first} disabled>
                  等待中
                </button>
              </div>
            </section>
          ))}
          {mixedSamples.map(([label, parent, input, button]) => (
            <section key={label}>
              <h2>{label}</h2>
              <div className={parent} data-alignment={label}>
                <input
                  className={input}
                  aria-label={label}
                  type={label.includes('日期') ? 'date' : 'text'}
                  defaultValue={label.includes('日期') ? '2026-11-17' : '8080'}
                  style={{ minWidth: 0 }}
                />
                <button type="button" className={button} aria-label={`更新${label}`}>
                  <RefreshCw size={14} />
                </button>
              </div>
            </section>
          ))}
          <section>
            <h2>日历年月</h2>
            <div className="weq-density-calendar-tools" data-alignment="日历年月">
              <button type="button" aria-label="上个月">
                <X size={14} />
              </button>
              <select aria-label="年份" defaultValue="2026">
                <option>2026</option>
              </select>
              <select aria-label="月份" defaultValue="11">
                <option>11</option>
              </select>
              <button type="button" aria-label="下个月">
                <X size={14} />
              </button>
            </div>
          </section>
          <section>
            <h2>头像排序</h2>
            <div className="weq-avatar-history-toolbar" data-alignment="头像排序">
              <SegmentedControl
                label="排序"
                value="first"
                onChange={() => {}}
                options={[
                  { value: 'first', label: '首次使用' },
                  { value: 'last', label: '最近使用' },
                ]}
              />
              <button type="button" aria-label="切换顺序">
                <RefreshCw size={14} />
              </button>
            </div>
          </section>
          <section className="weq-qzn">
            <h2>空间跳转</h2>
            <div className="weq-qzn-navigation">
              <form data-alignment="空间跳转" onSubmit={(event) => event.preventDefault()}>
                <input aria-label="好友 QQ 号" defaultValue="10001" />
                <button type="submit">
                  <RefreshCw size={14} />
                </button>
              </form>
            </div>
          </section>
          <section>
            <h2>类型与搜索</h2>
            <div className="weq-udp-filters" data-alignment="类型与搜索">
              <select className="weq-udp-select" aria-label="类型">
                <option>全部</option>
              </select>
              <input className="weq-udp-search" aria-label="搜索地址" placeholder="地址" />
            </div>
          </section>
          <section>
            <h2>分段选项</h2>
            <SegmentedControl
              label="范围"
              value="all"
              onChange={() => {}}
              options={[
                { value: 'all', label: '全部' },
                {
                  value: 'selected',
                  label: (
                    <span className="weq-set-seg-label">
                      <Download size={14} />
                      已选内容
                    </span>
                  ),
                },
                { value: 'none', label: '不可用', disabled: true },
              ]}
            />
          </section>
          <section>
            <h2>换行操作</h2>
            <Card title="操作">
              <div className="weq-set-actions" data-alignment="换行操作">
                <button type="button" className="weq-set-btn" style={{ maxWidth: 120 }}>
                  恢复默认配置并重新加载资源
                </button>
                <button type="button" className="weq-set-btn">
                  <RefreshCw size={14} />
                  刷新
                </button>
              </div>
            </Card>
          </section>
          <section className="weq-contact-profile-v2">
            <h2>资料页纵向操作</h2>
            <div className="weq-profile-page-actions alignment-column">
              <div className="weq-contact-actions" data-alignment-column>
                <button type="button" className="weq-contact-secondary">
                  打开会话
                </button>
                <button type="button" className="weq-contact-secondary">
                  <Download size={14} />
                  导出
                </button>
              </div>
            </div>
          </section>
          <section>
            <h2>省流量纵向控件</h2>
            <div className="weq-data-saver-duration" data-alignment-column>
              <SegmentedControl
                label="临时期限"
                value="tasks"
                onChange={() => {}}
                options={[
                  { value: 'tasks', label: '直到全部任务完成' },
                  { value: 'exit', label: '直到退出应用' },
                ]}
              />
              <button type="button" className="weq-set-btn">
                应用
              </button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
