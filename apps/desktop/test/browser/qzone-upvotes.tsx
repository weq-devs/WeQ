import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QzonePostArchive } from '../../src/renderer/src/components/QzoneUpvoteAction';
import { QzonePersonHeader } from '../../src/renderer/src/components/QzoneProfileAvatar';
import { QzonePublicNavigationContext } from '../../src/renderer/src/lib/qzoneNavigation';
import { QzonePublicPane } from '../../src/renderer/src/views/QzonePublicView';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/qzone.css';

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') || 'light';
document.documentElement.style.setProperty(
  '--weq-accent-effective',
  query.get('theme') === 'dark' ? '#51b88c' : '#98523e',
);
function Scene() {
  const [person, setPerson] = useState('');
  const space = (_uin: string, nickname?: string) => setPerson(nickname ?? '');
  return (
    <main
      className="weq-qzn"
      style={{ padding: 16, maxWidth: 620, margin: '32px auto', color: 'var(--foreground)' }}
    >
      <article className="weq-qzn-post" aria-label="普通说说">
        <QzonePublicNavigationContext.Provider value={() => setPerson('空友爱看')}>
          <QzonePostArchive
            selfUin="10001"
            hostUin={query.get('mode') === 'manage' ? '10001' : '10002'}
            tid="fixture"
            time={1700000000}
            enabled
            refresh={0}
            onSpace={space}
            render={({ tag, menu, upvote }) => (
              <>
                <header className="weq-qzn-post-head">
                  <QzonePersonHeader
                    nickname="合成普通说说作者"
                    size={34}
                    time={
                      <div className="weq-qzn-post-meta">
                        <time>昨天 12:00</time>
                        {tag}
                      </div>
                    }
                  />
                  {menu ? <div className="weq-qzn-post-tools">{menu}</div> : null}
                </header>
                <p className="weq-qzn-content">合成普通说说</p>
                <div className="weq-qzn-actions">{upvote}</div>
              </>
            )}
          />
        </QzonePublicNavigationContext.Provider>
      </article>
      <section aria-label="空友动态">
        <QzonePublicPane selfUin="10001" onSpace={space} />
      </section>
      <output aria-label="当前用户">{person}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Scene />);
