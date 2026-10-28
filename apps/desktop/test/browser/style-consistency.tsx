import { createRoot } from 'react-dom/client';
import { Check, ExternalLink, Heart, Sparkles } from 'lucide-react';
import { QqArk } from '../../src/renderer/src/components/ark/QqArk';
import { GrayTipXmlMessage } from '../../src/renderer/src/components/GrayTipXmlMessage';
import { ReplyJumpContext } from '../../src/renderer/src/components/QqMessageContent';
import { GrayTipFileRecvMessage } from '../../src/renderer/src/components/GrayTipFileRecvMessage';
import { ExternalSiteView } from '../../src/renderer/src/views/ExternalSiteView';
import {
  useThemeStore,
  type ThemeBackground,
  type ThemePreference,
} from '../../src/renderer/src/state/theme';
import { contrastRatio } from '../../src/shared/theme_colors';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/flash-transfer.css';
import '../../src/renderer/src/styles/settings-controls.css';
import '../../src/renderer/src/styles/workspace-surfaces.css';
import '../../src/renderer/src/styles/page-chrome.css';
import '../../src/renderer/src/styles/group-content-management.css';
import '../../src/renderer/src/styles/group-essence-actions.css';
import '../../src/renderer/src/styles/intent-sense.css';

declare global {
  interface Window {
    styleConsistency: {
      setTheme: (preference: ThemePreference, accent: string, background: ThemeBackground) => void;
      contrastRatio: typeof contrastRatio;
    };
  }
}

window.styleConsistency = {
  setTheme(preference, accent, background) {
    const store = useThemeStore.getState();
    store.setAccent(accent);
    store.setBackground(background);
    store.setPreference(preference);
  },
  contrastRatio,
};

function Fixture() {
  return (
    <main className="style-fixture">
      <style>{`
        html,body,#root{min-height:100%;margin:0}
        .style-fixture{min-height:100vh;padding:20px;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
        .style-fixture-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-items:start}
        .style-fixture h1{font-size:18px;margin:0 0 20px}
        .style-fixture h2{font-size:14px;margin:0 0 12px}
        .style-fixture-section{min-width:0}
        .style-fixture-controls{display:flex;align-items:center;gap:16px;padding:16px 0}
        .style-fixture .weq-extsite{padding:0;display:block}
        .style-fixture .weq-extsite-card{width:100%}
        .style-fixture .group-essence-dialog{width:100%;max-height:none}
        .style-fixture .group-essence-header{flex-wrap:wrap}
        @media(max-width:800px){.style-fixture-grid{grid-template-columns:minmax(0,1fr)}}
      `}</style>
      <h1>样式回归：合成数据</h1>
      <div className="style-fixture-grid">
        <section className="style-fixture-section">
          <h2>消息卡片</h2>
          <QqArk
            arkData={{
              app: 'com.tencent.security.message',
              meta: {
                message: {
                  title: '安全提醒',
                  details: [
                    {
                      detail_title1: '设备状态',
                      detail_content1: '合成详情',
                      detail_color1: '#000000',
                    },
                  ],
                  links: [{ link_title1: '查看详情', link_url1: 'https://example.invalid/' }],
                },
              },
            }}
          />
          <div className="style-fixture-controls">
            <label className="weq-ft-check" title="闪传选择">
              <input type="checkbox" defaultChecked aria-label="选择合成文件" />
              <Check className="weq-ft-check-mark" size={12} />
            </label>
            <button type="button" className="weq-set-chk is-on">
              <span className="weq-set-chk-box" />
              统一选择
            </button>
          </div>
          <div className="style-fixture-controls">
            <button type="button" className="weq-affinity-pill tier-unrated" title="互动画像">
              <Heart size={13} strokeWidth={2.2} />
              <span>互动画像</span>
            </button>
            <button type="button" className="weq-affinity-pill tier-2" title="好感度 60">
              <Sparkles size={13} strokeWidth={2.2} />
              <span>亲近 60</span>
            </button>
          </div>
          <ReplyJumpContext.Provider
            value={(target) => {
              window.dispatchEvent(new CustomEvent('graytip-jump', { detail: target }));
            }}
          >
            <GrayTipXmlMessage
              element={{
                type: 'grayTipXml',
                data: {
                  grayTipXmlContent:
                    '<gtip><nor txt="回应了你的"/><url jp="" msgseq="63954" col="3" txt="消息:"/><face type="1" id="424"/></gtip>',
                },
              }}
            />
          </ReplyJumpContext.Provider>
          <GrayTipFileRecvMessage
            element={{
              type: 'grayTipFileRecv',
              data: { fileName: '合成文件.txt', fileSize: 1024 },
            }}
          />
        </section>
        <section className="style-fixture-section">
          <h2>群精华</h2>
          <section className="group-essence-dialog">
            <header>
              <div>
                <strong>群精华</strong>
                <span>合成群聊</span>
              </div>
            </header>
            <div className="group-essence-body">
              <article className="group-essence-item is-clickable">
                <button type="button" className="weq-essence-jump">
                  <header className="group-essence-header">
                    <span className="group-essence-sender">合成成员</span>
                    <span className="group-essence-meta">2026/10/26</span>
                  </header>
                  <p className="group-essence-placeholder">已设为精华</p>
                </button>
                <div className="weq-essence-actions">
                  <button type="button" aria-label="更多">
                    ...
                  </button>
                </div>
              </article>
            </div>
          </section>
        </section>
        <section className="style-fixture-section">
          <h2>外部站点</h2>
          <ExternalSiteView
            site="qzone"
            label="QQ 空间"
            desc="合成站点入口"
            icon={<ExternalLink size={24} />}
          />
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
