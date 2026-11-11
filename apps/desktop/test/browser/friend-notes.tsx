import { createRoot } from 'react-dom/client';
import { FriendNotesEditor } from '../../src/renderer/src/components/FriendNotesEditor';
import type { useQQWriteSession } from '../../src/renderer/src/hooks/useQQWriteSession';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/qq-write.css';
import '../../src/renderer/src/styles/qq-remark.css';

const session: ReturnType<typeof useQQWriteSession> = {
  binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic' },
  available: true,
  busy: false,
  result: null,
  run: async (action, _refresh, options) => {
    await action(session.binding!);
    return (await options?.readback?.()) ?? true;
  },
};
createRoot(document.getElementById('root')!).render(
  <div
    className="weq-set weq-qq-remark-dialog"
    style={{
      width: 'min(440px, calc(100vw - 24px))',
      margin: '12px auto',
      border: '1px solid var(--weq-border-subtle)',
    }}
  >
    <header className="weq-qq-remark-head">
      <div>
        <strong>修改好友备注</strong>
        <span>合成联系人</span>
      </div>
    </header>
    <div className="weq-qq-remark-body">
      <FriendNotesEditor uid="u_peer" session={session} onDirtyChange={() => {}} />
    </div>
  </div>,
);
