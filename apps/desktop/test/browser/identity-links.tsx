import { useState } from 'react';
import { OverlayLayer } from '../../src/renderer/src/components/OverlayLayer';
import { createRoot } from 'react-dom/client';
import { ProfileChatShortcutContext } from '../../src/renderer/src/lib/chatNavigation';
import { TitleBar } from '../../src/renderer/src/im-template/template/TitleBar';
import { MobileWebNavigation } from '../../src/renderer/src/components/MobileWebNavigation';
import { QzonePersonIdentity } from '../../src/renderer/src/components/QzoneProfileAvatar';
import {
  QzonePersonContext,
  QzoneProfileContext,
} from '../../src/renderer/src/lib/qzoneNavigation';
import { ProfileNavigationContext } from '../../src/renderer/src/lib/profileNavigation';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/styles/workspace-tools.css';
import '../../src/renderer/src/styles/qzone.css';
import '../../src/renderer/src/styles/qzone-actions.css';
import '../../src/renderer/src/styles/qzone-interactions.css';

const params = new URLSearchParams(location.search);
const mobile = params.has('mobile');
document.documentElement.dataset.weqLayout = mobile ? 'single' : 'split';
const user = {
  id: 'u_self',
  uid: 'u_self',
  username: '合成账号',
  displayName: params.has('long-name') ? '用于验证竖屏顶栏省略的很长合成昵称' : '合成账号',
  identityLabel: 'QQ',
  identityValue: '10001',
  avatarUrl: null,
};
const noop = () => {};
const open = (kind: string, uin: string) => {
  const { dataset } = document.documentElement;
  dataset.identityTarget = `${kind}:${uin}`;
  dataset.identityActivations = `${dataset.identityActivations ?? ''}|${dataset.identityTarget}`;
};
const workspace = (showProfile: React.ContextType<typeof QzoneProfileContext>) => (
  <ProfileNavigationContext.Provider value={(user) => open('profile', user.identityValue)}>
    <QzoneProfileContext.Provider value={showProfile}>
      <QzonePersonContext.Provider
        value={{
          action: params.get('action') === 'profile' ? 'profile' : 'space',
          spaceUin: params.has('owner') ? '10002' : null,
          onSpace: (uin) => open('space', uin),
        }}
      >
        <style>{`html,body{margin:0;color:var(--foreground);background:var(--background);font-family:system-ui}*{box-sizing:border-box}.identity-fixture{padding:16px;max-width:720px;margin:auto}.identity-fixture .weq-qzn{display:block;padding:0}.identity-mobile{height:80px;position:relative}.identity-mobile .weq-mobile-navigation{position:static;height:auto;display:block}.identity-mobile .weq-mobile-bottom-nav,.identity-mobile .weq-mobile-more{display:none}.identity-fixture section{margin-bottom:20px}.identity-fixture .weq-qzn-like-users{max-width:360px}.identity-fixture .weq-qzn-post-head{margin-bottom:20px}`}</style>
        <style>{`.identity-mobile .weq-mobile-tabs{display:none}`}</style>
        {mobile ? (
          <div className="identity-mobile weq-web-shell">
            <MobileWebNavigation
              user={user}
              hidden={false}
              view="messages"
              query=""
              onQueryChange={noop}
              messageBadgeCount={0}
              contactBadgeCount={0}
              mailBadgeCount={0}
              onViewChange={noop}
              onOpenSettings={noop}
              onOpenDressUp={noop}
              onOpenCollection={noop}
            />
          </div>
        ) : (
          <TitleBar user={user} />
        )}
        <main className="identity-fixture">
          <section className="weq-qzn">
            <div className="weq-qzn-post-head">
              <div>
                <QzonePersonIdentity uin="10002" nickname="合成作者" size={34} />
                <time>2026-11-13 03:00</time>
              </div>
            </div>
            <div className="weq-qzn-like-users">
              {['合成点赞人', '很长很长的合成昵称用于核对窄屏不会挤占其他入口', '第三位'].map(
                (name, i) => (
                  <span key={name}>
                    <QzonePersonIdentity uin={String(10002 + i)} nickname={name} size={20} />
                  </span>
                ),
              )}
            </div>
            <div className="weq-qzn-comment">
              <div>
                <QzonePersonIdentity uin="10002" nickname="合成评论者" size={26} />
                <p>评论正文不在身份按钮内。</p>
                <div className="weq-qzn-comment-meta">
                  <time>03:00</time>
                  <button type="button" onClick={noop}>
                    回复
                  </button>
                </div>
              </div>
            </div>
          </section>
        </main>
      </QzonePersonContext.Provider>
    </QzoneProfileContext.Provider>
  </ProfileNavigationContext.Provider>
);

function Fixture() {
  const [cover, setCover] = useState<{ x: number; y: number } | null>(null);
  const closeCover = () => setCover(null);
  const showProfile = (uin: string, _name?: string, anchor?: { x: number; y: number }) => {
    open('profile', uin);
    if (params.has('shortcut') && anchor) setCover(anchor);
  };
  return (
    <ProfileChatShortcutContext.Provider
      value={
        params.has('shortcut')
          ? (target) => {
              if (target.kind !== 'direct') return;
              return {
                landscape: () => {
                  closeCover();
                  open('chat', target.user.identityValue);
                },
                portrait: () => open('poke', target.user.identityValue),
              };
            }
          : null
      }
    >
      {workspace(showProfile)}
      {cover && (
        <OverlayLayer presentation="popover" onClose={closeCover}>
          <div
            style={{
              position: 'fixed',
              left: cover.x - 12,
              top: cover.y - 12,
              width: 140,
              height: 75,
            }}
          >
            <button
              type="button"
              style={{ position: 'absolute', inset: 0 }}
              onClick={() => open('card', '10002')}
            >
              名片按钮
            </button>
          </div>
        </OverlayLayer>
      )}
    </ProfileChatShortcutContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
