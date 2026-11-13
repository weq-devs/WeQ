import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Palette } from 'lucide-react';
import { ComponentAppearance } from '../../src/renderer/src/components/settings/ComponentAppearance';
import { Row, Toggle } from '../../src/renderer/src/components/settings/controls';
import { SegmentedControl } from '../../src/renderer/src/components/SegmentedControl';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../support/templateDemoData';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import {
  componentStyles,
  ensureThemeInitialized,
  useThemeStore,
} from '../../src/renderer/src/state/theme';
import { contrastRatio } from '../../src/shared/theme_colors';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/styles/page-chrome.css';
import '../../src/renderer/src/styles/workspace-surfaces.css';
import '../../src/renderer/src/styles/hover-tooltip.css';
import '../../src/renderer/src/styles/workspace-menu.css';

ensureThemeInitialized();
Object.assign(window, { appearanceQa: { store: useThemeStore, componentStyles, contrastRatio } });
const demo = createTemplateDemoData();
const seed = demo.conversations.find((row) => row.type === 'direct')!;
const conversations = Array.from({ length: 200 }, (_, index) => ({
  ...seed,
  id: `fixture-${index}`,
}));

function Fixture() {
  const [checked, setChecked] = useState(true);
  const [scope, setScope] = useState('all');
  return (
    <ContentSelectionProvider>
      <style>{`
        html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}
        .appearance-fixture{padding:24px;min-height:100vh;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
        .appearance-fixture h1{font-size:20px;margin:0 0 20px}
        .appearance-fixture h2{font-size:15px;margin:0 0 12px}
        .appearance-columns{display:grid;grid-template-columns:minmax(0,600px) minmax(0,360px);gap:24px;max-width:984px;margin:auto}
        .appearance-fixture .weq-settings-dialog{display:grid;grid-template-columns:minmax(0,1fr);width:auto;min-width:0;height:auto;gap:16px;background:transparent;border:0;border-radius:0;padding:0;box-shadow:none}
        .appearance-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0}
        .appearance-fixture .weq-input{max-width:100%}
        .appearance-fixture .weq-directory-scope-menu{position:static;margin-top:16px}
        .appearance-fixture .weq-conversation-directory{height:320px}
        .appearance-fixture .appearance-list-shell{position:static;inset:auto;height:320px;isolation:auto}
        .appearance-fixture .appearance-list-shell .app-shell{display:block;height:320px;min-width:0}
        .appearance-fixture .modal-card{padding:16px;margin-top:16px}
        .appearance-fixture table{width:100%;margin-top:16px;font-size:13px}
        .appearance-fixture td{padding:12px;border-bottom:1px solid var(--weq-border-subtle)}
        .appearance-extended{display:grid;gap:12px;max-width:984px;margin:24px auto 0}
        .appearance-extended .weq-workspace-content{height:auto;overflow:visible}
        .appearance-extended .weq-workspace-page{height:auto;overflow:visible}
        .appearance-extended .weq-workspace-menu{position:static;width:100%;height:auto}
        .appearance-extended .weq-hover-tooltip{position:static;max-width:100%}
        .appearance-extended .weq-collection-filters{display:flex;flex-wrap:wrap}
        @media(max-width:720px){.appearance-fixture{padding:16px}.appearance-columns{grid-template-columns:minmax(0,1fr)}}
      `}</style>
      <main className="appearance-fixture">
        <div className="appearance-columns">
          <section>
            <h1>主题与背景</h1>
            <div className="weq-settings-dialog">
              <ComponentAppearance />
            </div>
          </section>
          <section>
            <h2>控件与会话</h2>
            <div className="appearance-controls">
              <button type="button" className="weq-set-btn">
                保存
              </button>
              <button type="button" className="weq-set-btn weq-set-btn-soft">
                取消
              </button>
              <button type="button" className="weq-set-btn weq-set-btn-danger">
                删除
              </button>
              <button type="button" className="weq-set-btn weq-set-btn-soft" disabled>
                不可用
              </button>
              <input className="weq-input" aria-label="搜索" placeholder="搜索聊天记录" />
            </div>
            <Row
              label="消息提醒"
              control={<Toggle checked={checked} onChange={setChecked} label="消息提醒" />}
            />
            <div className="app-shell-root weq-web-shell appearance-list-shell">
              <div className="app-shell">
                <ConversationList
                  conversations={conversations}
                  activeConversationId="fixture-0"
                  preferences={{}}
                  drafts={{}}
                  user={demo.user}
                  onSelect={() => {}}
                />
              </div>
            </div>
            <div className="weq-directory-scope-menu">
              <button type="button">复制</button>
              <button type="button" aria-checked="true">
                查看详情
              </button>
            </div>
            <div className="modal-card">
              <h2>保存更改</h2>
              <div className="appearance-controls">
                <button type="button" className="primary-button">
                  确定
                </button>
                <button type="button" className="secondary-button">
                  取消
                </button>
              </div>
            </div>
            <table>
              <tbody>
                <tr>
                  <td>会话</td>
                  <td>200</td>
                </tr>
                <tr>
                  <td>消息</td>
                  <td>1200</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
        <section className="appearance-extended">
          <SegmentedControl
            label="内容范围"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: '全部内容' },
              { value: 'selected', label: '已选内容' },
              { value: 'disabled', label: '不可用', disabled: true },
            ]}
          />
          <div className="weq-workspace-content">
            <div className="weq-workspace-page">
              <section className="weq-collection-dialog">
                <header className="weq-collection-head">
                  <h2>收藏</h2>
                </header>
                <nav className="weq-collection-filters" aria-label="收藏分类">
                  <button type="button" className="weq-collection-chip is-active">
                    全部
                  </button>
                  <button type="button" className="weq-collection-chip">
                    图片
                  </button>
                </nav>
                <label className="weq-collection-search">
                  <input aria-label="搜索收藏" placeholder="搜索收藏" />
                </label>
                <button type="button" className="weq-settings-nav-item is-active">
                  <Palette size={16} />
                  <span className="weq-settings-nav-label">主题与背景</span>
                </button>
                <article className="weq-dress-card">装扮预览</article>
              </section>
            </div>
          </div>
          <section className="weq-workspace-menu weq-modal">
            <header className="weq-workspace-menu-head">
              <h2>任务</h2>
            </header>
            <div className="weq-workspace-actions">
              <button type="button">导出</button>
              <button type="button" disabled>
                不可用
              </button>
            </div>
          </section>
          <div className="weq-hover-tooltip">保存到本机</div>
        </section>
      </main>
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
