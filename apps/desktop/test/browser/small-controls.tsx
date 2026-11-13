import { useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { SelfAvatarHistory } from '../../src/renderer/src/components/SelfAvatarHistory';
import {
  FriendDirectoryContext,
  FriendDirectoryControls,
} from '../../src/renderer/src/components/FriendDirectoryControls';
import { ProfileExtras } from '../../src/renderer/src/components/ProfileExtras';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { qa } from './small-controls.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/contact-workspace.css';
import '../../src/renderer/src/styles/conversation-overview-calendar.css';
import '../../src/renderer/src/styles/profile-like.css';
import '../../src/renderer/src/styles/group-album-feed.css';
import '../../src/renderer/src/styles/remote.css';
import '../../src/renderer/src/styles/content-reference-selection.css';
import '../../src/renderer/src/styles/clone-task-log.css';
import '../../src/renderer/src/styles/contact-directory-order.css';
import '../../src/renderer/src/styles/mail.css';
import '../../src/renderer/src/styles/conversation-directory.css';
import '../../src/renderer/src/lib/inputModality';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { smallControlsQa: qa, smallControlsTheme: useThemeStore });

function DirectoryActions() {
  const directory = useContext(FriendDirectoryContext)!;
  return (
    <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" className="weq-set-btn" onClick={directory.create}>
        新建分组
      </button>
      <button
        type="button"
        className="weq-set-btn weq-set-btn-soft"
        onClick={() => directory.edit('delete', 1)}
      >
        删除分组
      </button>
    </nav>
  );
}
function Fixture() {
  return (
    <main
      style={{ padding: 18, maxWidth: 700, margin: '0 auto', height: '100dvh', overflow: 'auto' }}
    >
      <SelfAvatarHistory uin="10001" className="weq-set-btn">
        头像记录
      </SelfAvatarHistory>
      <FriendDirectoryControls>
        <DirectoryActions />
      </FriendDirectoryControls>
      <ProfileExtras uin="10001" section="signature" />
      <ProfileExtras uin="10001" />
      <section data-title-samples hidden>
        <header className="weq-field-history-header">
          <h3>昵称历史</h3>
        </header>
        <section className="weq-overview-calendar">
          <h3>会话日历</h3>
          <h4>会话</h4>
        </section>
        <section className="weq-profile-like-dialog">
          <header>
            <h3>资料卡点赞</h3>
          </header>
        </section>
        <header className="group-feed-discussion-head">
          <h3>评论</h3>
        </header>
        <section className="weq-qzn-forward-dialog">
          <h2>转发到我的空间</h2>
        </section>
        <section className="weq-remote-key-form">
          <h3>连接密钥</h3>
        </section>
        <section className="weq-reference-export">
          <h3>精确内容导出</h3>
        </section>
        <section className="weq-clone-task-log">
          <h3>任务日志</h3>
        </section>
        <section className="weq-contact-task-log">
          <h3>更新日志</h3>
        </section>
        <section className="weq-mail-connection">
          <h2>连接邮箱</h2>
        </section>
        <section className="weq-conversation-action-confirm">
          <h3>批量操作确认</h3>
        </section>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
