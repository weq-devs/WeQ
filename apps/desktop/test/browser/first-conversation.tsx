import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ConversationFirstPage } from '../../src/renderer/src/lib/conversationFirstPage';
import { ConversationWindowCache } from '../../src/renderer/src/lib/conversationWindowCache';
import { loadConversationEntry } from '../../src/renderer/src/lib/conversationEntry';
import type { Message } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';

type Row = Message & { msgSeq: string };
const demo = createTemplateDemoData();
const avatar =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
const user = { ...demo.user, avatarUrl: avatar };
const conversation = {
  ...demo.conversations.find((row) => row.type === 'direct')!,
  id: 'u_first',
  unreadCount: 0,
  otherUser: { ...user, id: 'u_peer', displayName: '首次进入测试', avatarUrl: avatar },
};
const target = { kind: 'c2c' as const, conv: conversation.id, limit: 50 };
const warm = new URLSearchParams(location.search).has('warm');
const row = (seq: number): Row => ({
  id: `row-${seq}`,
  msgSeq: String(seq),
  conversationId: conversation.id,
  senderId: user.id,
  sender: user,
  body:
    seq === 25
      ? '本地首屏已经可读'
      : seq === 26
        ? '漫游缓存已合并'
        : `本地历史 ${seq}：用于检查首次进入时的正文定位。`,
  createdAt: new Date(1792544400000 + seq * 1000).toISOString(),
});
const cache = new ConversationWindowCache<Row>();
const qa = {
  reads: 0,
  prefetched: false,
  complete: false,
  clickedAt: 0,
  firstCommitMs: null as number | null,
  firstBeforeComplete: false,
};
Object.assign(window, { firstConversationQa: qa });
function App() {
  const [opened, setOpened] = useState(false),
    [rows, setRows] = useState<Row[]>([]),
    [loading, setLoading] = useState(false);
  const current = useRef(true);
  const loader = useMemo(
    () =>
      new ConversationFirstPage<Row>({
        owner: 'browser',
        fresh: () => Boolean(cache.get('first')),
        valid: () => current.current,
        version: () => 0,
        subscribe(_target, _window, prefetch, stage) {
          qa.reads++;
          const local = setTimeout(
            () =>
              stage({ rows: Array.from({ length: 25 }, (_, i) => row(25 - i)), complete: false }),
            100,
          );
          const full = setTimeout(() => {
            qa.complete = true;
            if (prefetch) qa.prefetched = true;
            stage({ rows: Array.from({ length: 26 }, (_, i) => row(26 - i)), complete: true });
          }, 800);
          return () => {
            clearTimeout(local);
            clearTimeout(full);
          };
        },
        promote() {},
        cancel() {},
        store(_target, result) {
          cache.put('first', {
            rows: [...result].reverse(),
            anchored: true,
            hasOlder: false,
            hasNewer: false,
            scrollTop: 0,
            revision: 0,
            dirty: false,
            storedAt: Date.now(),
            verifiedAt: Date.now(),
          });
        },
      }),
    [],
  );
  useEffect(() => {
    loader.activate(warm, '');
    if (warm) loader.setVisible([target]);
    return () => {
      current.current = false;
      loader.dispose();
      cache.clear();
    };
  }, [loader]);
  useLayoutEffect(() => {
    if (opened && rows.length && qa.firstCommitMs === null) {
      qa.firstCommitMs = performance.now() - qa.clickedAt;
      qa.firstBeforeComplete = !qa.complete;
    }
  }, [opened, rows]);
  function open() {
    qa.clickedAt = performance.now();
    setOpened(true);
    loader.activate(warm, 'c2c:u_first');
    const cached = cache.get('first');
    if (cached) {
      setRows(cached.rows);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadConversationEntry<Row>({
      dirty: false,
      limit: 50,
      current: () => current.current,
      latest: async () => [],
      progressiveLatest: (_limit, show) => loader.read(target, show),
      before: async () => [],
      after: async () => [],
      show: (page, _first, complete = true) => {
        setRows(page.rows);
        setLoading(!complete);
      },
    });
  }
  return (
    <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <button type="button" onClick={open} style={{ padding: 12 }}>
        打开尚未打开的会话
      </button>
      {opened ? (
        <div
          className="weq-readonly-chat"
          style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,1fr)' }}
        >
          <ChatPane
            user={user}
            conversation={conversation}
            messages={rows}
            loading={loading && !rows.length}
            loadingNewer={loading && rows.length > 0}
            atLatest
            draft=""
            tabActive
            onSend={async () => {}}
            onDraftChange={() => {}}
            onDraftClear={() => {}}
            onBack={() => {}}
          />
        </div>
      ) : null}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ContentSelectionProvider>
    <App />
  </ContentSelectionProvider>,
);
