import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { X, Save } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { useViewState } from '../state/view';
import { useToast } from './Toast';
import { Modal } from './Dialog';
import '../styles/friend-directory.css';

type Category = { id: number; name: string; buddyCount: number | null; sortOrder: number | null };
type Operation =
  | { type: 'create'; name: string }
  | { type: 'rename'; id: number; name: string }
  | { type: 'delete'; id: number; mergeInto?: number }
  | { type: 'sort'; ids: number[] }
  | { type: 'move'; uids: string[]; categoryId: number };
type Editor = { scope: string } & (
  | { type: 'create' }
  | { type: 'rename' | 'delete'; id: number }
  | { type: 'move'; uids: string[] }
);
export const FriendDirectoryContext = createContext<{
  categories: Category[] | null;
  assignments: Map<string, number>;
  busy: boolean;
  available: boolean;
  error?: string;
  retry?: () => void;
  create: () => void;
  edit: (type: 'rename' | 'delete', id: number) => void;
  move: (uids: string[], categoryId?: number) => void;
  sort: (id: number, target: number | 'first' | 'last', position?: 'before' | 'after') => void;
} | null>(null);

export function FriendDirectoryControls({ children }: { children: ReactNode }) {
  const session = useQQWriteSession('friend-directory');
  const view = useViewState((state) => state.openedUin);
  const scope = `${view}:${session.binding?.expectedAccountConfigId ?? ''}`;
  const current = useRef(scope);
  current.current = scope;
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [error, setError] = useState('');
  const utils = trpc.useUtils();
  const roster = trpc.account.qqWrite.friendRoster.useQuery(session.binding!, {
    enabled: session.available,
    staleTime: 10000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const mutation = trpc.account.qqWrite.friendCategories.useMutation();
  const categories = roster.data?.categories ?? null;
  const assignments = useMemo(
    () =>
      new Map(
        roster.data?.friends.flatMap((row) =>
          row.categoryId === undefined ? [] : [[row.uid, row.categoryId] as const],
        ),
      ),
    [roster.data?.friends],
  );
  async function run(operation: Operation) {
    if (!session.binding || !session.available || running.current) return;
    const captured = scope;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await mutation.mutateAsync({ ...session.binding, operation });
      if (current.current !== captured) return;
      await roster.refetch();
      await Promise.all([
        utils.account.listCategories.invalidate(),
        utils.account.listBuddies.invalidate(),
      ]);
      if (current.current !== captured) return;
      if (result.state !== 'confirmed') throw new Error('操作已提交，读回尚未确认，请刷新后核对');
      useToast
        .getState()
        .push({ title: '好友分组已更新', tone: 'success', durationKind: 'success' });
      setEditor(null);
    } catch (cause) {
      if (current.current !== captured) return;
      await roster.refetch();
      if (current.current !== captured) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      useToast.getState().push({ title: message, tone: 'warning', durationKind: 'failure' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function edit(type: 'create' | 'rename' | 'delete', id?: number) {
    if (type !== 'create' && id === undefined) return;
    setName(categories?.find((row) => row.id === id)?.name ?? '');
    setMergeInto('');
    setError('');
    if (type === 'create') setEditor({ scope, type });
    else if (id !== undefined) setEditor({ scope, type, id });
  }
  const activeEditor = editor?.scope === scope ? editor : null;
  const activeCategoryId = activeEditor && 'id' in activeEditor ? activeEditor.id : undefined;
  const memberCount =
    roster.data?.friends.filter((row) => row.categoryId === activeCategoryId).length ?? 0;
  return (
    <FriendDirectoryContext.Provider
      value={{
        categories,
        assignments,
        busy,
        available: session.available && !roster.error && Boolean(categories),
        error:
          roster.error?.message ??
          (session.available && roster.data && !categories ? '云端未返回好友分组目录' : undefined),
        retry: () => void roster.refetch(),
        create: () => edit('create'),
        edit,
        move: (uids, categoryId) => {
          const targets = [...new Set(uids)];
          if (!targets.length) return;
          if (categoryId !== undefined) {
            void run({ type: 'move', uids: targets, categoryId });
          } else if (session.available && categories && !roster.error && !running.current) {
            setMergeInto('');
            setError('');
            setEditor({ scope, type: 'move', uids: targets });
          }
        },
        sort: (id, target, position = 'before') => {
          if (!categories) return;
          const ids = [...categories]
            .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
            .map((row) => row.id);
          if (!ids.includes(id) || target === id) return;
          const next = ids.filter((value) => value !== id);
          if (typeof target === 'number' && !next.includes(target)) return;
          const index =
            target === 'first'
              ? 0
              : target === 'last'
                ? next.length
                : next.indexOf(target) + (position === 'after' ? 1 : 0);
          next.splice(index, 0, id);
          if (next.join(',') !== ids.join(',')) void run({ type: 'sort', ids: next });
        },
      }}
    >
      {children}
      {activeEditor && (
        <Modal
          centered
          width={400}
          onClose={() => {
            if (!busy) setEditor(null);
          }}
          className="weq-friend-directory-editor"
          title="好友分组"
        >
          <header>
            <h3>
              {activeEditor.type === 'move'
                ? '移动分组'
                : activeEditor.type === 'create'
                  ? '新建分组'
                  : activeEditor.type === 'rename'
                    ? '重命名分组'
                    : '删除分组'}
            </h3>
            <button
              type="button"
              title="关闭"
              aria-label="关闭"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              <X size={18} />
            </button>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (activeEditor.type === 'move') {
                if (mergeInto !== '')
                  void run({
                    type: 'move',
                    uids: activeEditor.uids,
                    categoryId: Number(mergeInto),
                  });
              } else if (activeEditor.type === 'create')
                void run({ type: 'create', name: name.trim() });
              else if (activeEditor.type === 'rename')
                void run({ type: 'rename', id: activeEditor.id, name: name.trim() });
              else
                void run({
                  type: 'delete',
                  id: activeEditor.id,
                  ...(mergeInto === '' ? {} : { mergeInto: Number(mergeInto) }),
                });
            }}
          >
            {activeEditor.type === 'move' ? (
              <label>
                将 {activeEditor.uids.length} 位好友移动到
                <select
                  autoFocus
                  required
                  value={mergeInto}
                  disabled={busy}
                  onChange={(event) => setMergeInto(event.target.value)}
                >
                  <option value="" disabled>
                    选择分组
                  </option>
                  {[...(categories ?? [])]
                    .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : activeEditor.type === 'delete' ? (
              <>
                <p>删除「{categories?.find((row) => row.id === activeEditor.id)?.name}」？</p>
                {memberCount > 0 && (
                  <label>
                    将 {memberCount} 位好友合并到
                    <select
                      required
                      value={mergeInto}
                      disabled={busy}
                      onChange={(event) => setMergeInto(event.target.value)}
                    >
                      <option value="" disabled>
                        选择分组
                      </option>
                      {(categories ?? [])
                        .filter((row) => row.id !== activeEditor.id)
                        .map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <label>
                分组名称
                <input
                  autoFocus
                  required
                  maxLength={255}
                  disabled={busy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {error && <p role="alert">{error}</p>}
            <footer>
              <button type="button" disabled={busy} onClick={() => setEditor(null)}>
                取消
              </button>
              <button
                type="submit"
                disabled={
                  busy ||
                  ((activeEditor.type === 'create' || activeEditor.type === 'rename') &&
                    !name.trim()) ||
                  (activeEditor.type === 'move' && mergeInto === '') ||
                  (activeEditor.type === 'delete' && memberCount > 0 && mergeInto === '')
                }
              >
                <Save size={15} />
                {busy
                  ? '正在处理'
                  : activeEditor.type === 'delete'
                    ? '删除'
                    : activeEditor.type === 'move'
                      ? '移动'
                      : '保存'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </FriendDirectoryContext.Provider>
  );
}

export const useFriendDirectory = () => useContext(FriendDirectoryContext);
