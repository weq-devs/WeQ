import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ComponentAppearance } from '../../src/renderer/src/components/settings/ComponentAppearance';
import { Row, Toggle } from '../../src/renderer/src/components/settings/controls';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../../src/renderer/src/im-template/template/demoData';
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
  return (
    <ContentSelectionProvider>
      <style>{`
        html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}
        .appearance-fixture{padding:24px;min-height:100vh;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
        .appearance-fixture h1{font-size:20px;margin:0 0 20px}
        .appearance-fixture h2{font-size:15px;margin:0 0 12px}
        .appearance-columns{display:grid;grid-template-columns:minmax(0,600px) minmax(0,360px);gap:24px;max-width:984px;margin:auto}
        .appearance-fixture .weq-settings-dialog{display:grid;grid-template-columns:minmax(0,1fr);width:auto;min-width:0;height:auto;gap:16px;background:transparent;border:0;padding:0;box-shadow:none}
        .appearance-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0}
        .appearance-fixture .weq-input{max-width:100%}
        .appearance-fixture .weq-directory-scope-menu{position:static;margin-top:16px}
        .appearance-fixture .weq-conversation-directory{height:320px}
        .appearance-fixture .appearance-list-shell{position:static;inset:auto;height:320px;isolation:auto}
        .appearance-fixture .appearance-list-shell .app-shell{display:block;height:320px;min-width:0}
        .appearance-fixture .modal-card{padding:16px;margin-top:16px}
        .appearance-fixture table{width:100%;margin-top:16px;font-size:13px}
        .appearance-fixture td{padding:12px;border-bottom:1px solid var(--weq-border-subtle)}
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
      </main>
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
