// @ts-nocheck
/**
 * 群关键词提醒 —— 共享的关键词编辑逻辑 + 灯箱外壳。
 *
 * 结构：
 *   - {@link GroupKeywordEditor}：关键词列表 + 每个词的成员范围。**不带遮罩 / 标题栏 /
 *     页脚**，好让两种载体共用同一份实现：
 *       · {@link GroupKeywordDialog} —— 群聊顶栏「提醒」按钮打开的灯箱；
 *       · 会话设置大卡片（`ConversationSettingsDialog`）的「群关键词」页内嵌。
 *   - 关键词列表：每个关键词一张卡片，**各自带自己的成员范围**（空 = 全部成员）。
 *     早期版本把成员范围存在群一级，给新词设范围会覆盖旧词；现在按词存。
 *   - 成员范围：在关键词卡片上点「指定成员」就地展开搜索 / 快捷选择（群主 / 全部管理员）。
 *
 * 规则写到本地（主进程 user config），主进程按它匹配新到达的群消息。这里只管读写
 * 这份配置，不碰任何消息库。整体视觉沿用群公告灯箱那套（主题色 / 深浅模式自动跟随）。
 *
 * 保存时机：改动后**防抖写回**（免得每敲一个字打一次 IPC），卸载时再 `flush` 一次 ——
 * 编辑器一卸载（灯箱点完成 / 会话设置关窗）就落盘，否则「加完词立刻关闭」会落在防抖
 * 窗口里被丢掉。
 */

import { BellRing, Crown, Search, ShieldCheck, Trash2, UserRound, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { client } from '../trpc/client';
import { Avatar } from '../im-template/template/primitives';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import { cn } from '../im-template/template/classNames';

export interface KeywordMember {
  uid: string;
  displayName: string;
  avatarUrl: string | null;
  uin?: string;
  role: 'owner' | 'admin' | 'member';
}

/** 一个关键词 + 它自己的成员范围；与主进程 groupKeyword.rules[群号].keywords 一一对应。 */
type KeywordEntry = { keyword: string; memberUids: string[] };
type RuleMap = Record<string, { keywords: KeywordEntry[] }>;

/**
 * 关键词编辑器本体（无外壳）。`groupId` 变化会重新读配置；卸载时 flush。
 *
 * `onSaveState` 把「保存中… / 已保存」外抛给载体渲染 —— 灯箱放页脚，会话设置放页头，
 * 编辑器自己不管这块 UI。
 */
export function GroupKeywordEditor({
  groupId,
  members,
  onSaveState,
}: {
  groupId: string;
  members: KeywordMember[];
  onSaveState?: (state: { saving: boolean; savedAt: number }) => void;
}): ReactElement {
  const [entries, setEntries] = useState<KeywordEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const rulesRef = useRef<RuleMap>({});
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  // 最新草稿的镜像：防抖回调 / flush 都在闭包外读它，避免拿到过期的 state。
  const entriesRef = useRef<KeywordEntry[]>([]);
  // 输入框里还没回车的词的镜像：卸载时的 flush 也要算上它。
  const draftRef = useRef('');

  const memberByUid = useMemo(() => {
    const map = new Map<string, KeywordMember>();
    for (const m of members) map.set(m.uid, m);
    return map;
  }, [members]);

  // 状态外抛给载体（灯箱页脚 / 会话设置页头）。
  useEffect(() => {
    onSaveState?.({ saving, savedAt });
  }, [saving, savedAt, onSaveState]);

  // 读当前全部规则（保留其它群的），取本群那份作为草稿。
  useEffect(() => {
    let cancelled = false;
    client.bootstrap.getSettings
      .query()
      .then((settings) => {
        if (cancelled) return;
        const rules: RuleMap = settings?.groupKeyword?.rules ?? {};
        rulesRef.current = rules;
        const mine = rules[groupId]?.keywords ?? [];
        setEntries(mine);
        entriesRef.current = mine;
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  // 把当前草稿整体写回主进程（按群号 keyed，其余群原样保留）。幂等。
  const flush = useCallback((): void => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const nextRules: RuleMap = { ...rulesRef.current };
    const keywords = entriesRef.current
      .map((entry) => ({
        keyword: entry.keyword.trim(),
        memberUids: entry.memberUids,
      }))
      .filter((entry) => entry.keyword !== '');
    if (keywords.length === 0) delete nextRules[groupId];
    else nextRules[groupId] = { keywords };
    rulesRef.current = nextRules;
    setSaving(true);
    client.bootstrap.setGroupKeywordRules
      .mutate({ rules: nextRules })
      .then(() => setSavedAt(Date.now()))
      .catch(() => undefined)
      .finally(() => setSaving(false));
  }, [groupId]);

  // 改动后防抖写回；先同步镜像草稿，好让 flush（卸载时）总能拿到最新值。
  useEffect(() => {
    entriesRef.current = entries;
    if (!loaded) return undefined;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flush();
    }, 400);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [entries, loaded, flush]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // 卸载前 flush：载体关闭（灯箱点完成 / 会话设置关窗）不能丢掉防抖窗口里的改动。
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // 输入框里还没回车的词也算数 —— 用户「打完字直接关闭」是常见操作。
      const pending = draftRef.current.trim();
      if (
        pending &&
        !entriesRef.current.some((e) => e.keyword.toLowerCase() === pending.toLowerCase())
      ) {
        dirtyRef.current = true;
        entriesRef.current = [...entriesRef.current, { keyword: pending, memberUids: [] }];
      }
      flush();
    };
  }, [flush]);

  function applyEntries(next: KeywordEntry[]) {
    dirtyRef.current = true;
    entriesRef.current = next;
    setEntries(next);
  }

  function addKeyword() {
    const word = draft.trim();
    if (!word) return;
    if (entries.some((e) => e.keyword.toLowerCase() === word.toLowerCase())) {
      setDraft('');
      return;
    }
    applyEntries([...entriesRef.current, { keyword: word, memberUids: [] }]);
    setDraft('');
  }

  function removeKeyword(index: number) {
    applyEntries(entriesRef.current.filter((_, i) => i !== index));
    setEditingIndex((current) => {
      if (current === null) return null;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
  }

  function setEntryMembers(index: number, memberUids: string[]) {
    applyEntries(
      entriesRef.current.map((entry, i) => (i === index ? { ...entry, memberUids } : entry)),
    );
  }

  function toggleMember(index: number, uid: string) {
    const entry = entriesRef.current[index];
    if (!entry) return;
    const next = entry.memberUids.includes(uid)
      ? entry.memberUids.filter((u) => u !== uid)
      : [...entry.memberUids, uid];
    setEntryMembers(index, next);
  }

  function selectRole(index: number, role: 'owner' | 'admin') {
    const uids =
      role === 'owner'
        ? members.filter((m) => m.role === 'owner').map((m) => m.uid)
        : members.filter((m) => m.role === 'admin' || m.role === 'owner').map((m) => m.uid);
    const prev = entriesRef.current[index]?.memberUids ?? [];
    setEntryMembers(index, [...new Set([...prev, ...uids])]);
  }

  const ownerCount = members.filter((m) => m.role === 'owner').length;
  const adminCount = members.filter((m) => m.role === 'admin').length;
  const searchResults = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    if (!q || editingIndex === null) return [];
    const selected = new Set(entries[editingIndex]?.memberUids ?? []);
    return members
      .filter((m) => !selected.has(m.uid))
      .filter((m) => `${m.displayName} ${m.uin ?? ''}`.toLowerCase().includes(q))
      .slice(0, 20);
  }, [memberQuery, members, entries, editingIndex]);

  function memberLabel(uid: string): KeywordMember {
    return (
      memberByUid.get(uid) ?? { uid, displayName: uid, avatarUrl: null, role: 'member' as const }
    );
  }

  return (
    <div className="group-keyword-editor">
      <section className="group-keyword-section">
        <div className="group-keyword-label-row">
          <span className="group-keyword-label">关键词</span>
          <span className="group-keyword-desc">命中即提醒；每个词可单独限定发言人</span>
        </div>
        <div className="group-keyword-input-row">
          <input
            className="group-keyword-input"
            value={draft}
            placeholder="输入关键词后回车"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addKeyword();
              }
            }}
          />
        </div>
      </section>

      {entries.length === 0 ? (
        <div className="group-keyword-empty-card">未设置关键词，此群不会提醒</div>
      ) : (
        <ul className="group-keyword-list">
          {entries.map((entry, index) => {
            const editing = editingIndex === index;
            const selected = entry.memberUids.map(memberLabel);
            return (
              <li key={entry.keyword} className={cn('group-keyword-item', editing && 'editing')}>
                <div className="group-keyword-item-head">
                  <span className="group-keyword-item-word">{entry.keyword}</span>
                  <button
                    type="button"
                    className="group-keyword-item-scope"
                    title="设置该关键词的成员范围"
                    onClick={() => {
                      setEditingIndex(editing ? null : index);
                      setMemberQuery('');
                    }}
                  >
                    {entry.memberUids.length === 0 ? (
                      <>
                        <Users size={13} />
                        全部成员
                      </>
                    ) : (
                      <>
                        <UserRound size={13} />
                        {entry.memberUids.length} 人
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="group-keyword-item-remove"
                    title="删除关键词"
                    onClick={() => removeKeyword(index)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {entry.memberUids.length > 0 ? (
                  <div className="group-keyword-members">
                    {selected.slice(0, 8).map((m) => (
                      <span key={m.uid} className="group-keyword-member" title={m.displayName}>
                        <Avatar name={m.displayName} avatarUrl={m.avatarUrl} seed={m.uid} />
                        <span className="group-keyword-member-name">{m.displayName}</span>
                      </span>
                    ))}
                    {selected.length > 8 ? (
                      <span className="group-keyword-member-more">+{selected.length - 8}</span>
                    ) : null}
                  </div>
                ) : null}

                {editing ? (
                  <div className="group-keyword-editor-panel">
                    <div className="group-keyword-quick">
                      <button
                        type="button"
                        className="group-keyword-quick-btn"
                        disabled={ownerCount === 0}
                        onClick={() => selectRole(index, 'owner')}
                      >
                        <Crown size={13} />
                        群主
                      </button>
                      <button
                        type="button"
                        className="group-keyword-quick-btn"
                        disabled={adminCount === 0}
                        onClick={() => selectRole(index, 'admin')}
                      >
                        <ShieldCheck size={13} />
                        全部管理员
                      </button>
                      <button
                        type="button"
                        className="group-keyword-quick-btn"
                        disabled={entry.memberUids.length === 0}
                        onClick={() => setEntryMembers(index, [])}
                      >
                        清除（=全部）
                      </button>
                    </div>

                    {selected.length > 0 ? (
                      <div className="group-keyword-members">
                        {selected.map((m) => (
                          <span key={m.uid} className="group-keyword-member">
                            <Avatar name={m.displayName} avatarUrl={m.avatarUrl} seed={m.uid} />
                            <span className="group-keyword-member-name">{m.displayName}</span>
                            <button
                              type="button"
                              title="移除"
                              onClick={() => toggleMember(index, m.uid)}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="group-keyword-search">
                      <Search size={14} />
                      <input
                        value={memberQuery}
                        placeholder="搜索成员"
                        onChange={(e) => setMemberQuery(e.target.value)}
                      />
                    </div>
                    {memberQuery.trim() ? (
                      <div className="group-keyword-results">
                        {searchResults.length === 0 ? (
                          <div className="group-keyword-empty">没有匹配的成员</div>
                        ) : (
                          searchResults.map((m) => (
                            <button
                              key={m.uid}
                              type="button"
                              className="group-keyword-result"
                              onClick={() => {
                                toggleMember(index, m.uid);
                                setMemberQuery('');
                              }}
                            >
                              <Avatar name={m.displayName} avatarUrl={m.avatarUrl} seed={m.uid} />
                              <span className="group-keyword-member-name">{m.displayName}</span>
                              {m.role === 'owner' ? <Crown size={12} /> : null}
                              {m.role === 'admin' ? <ShieldCheck size={12} /> : null}
                            </button>
                          ))
                        )}
                      </div>
                    ) : (
                      <div className="group-keyword-scope-hint">
                        {entry.memberUids.length === 0
                          ? '当前不限定发言人 —— 任何成员提到这个词都会提醒。'
                          : '只有列表内的成员提到这个词才会提醒。'}
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 群关键词提醒灯箱 —— 群聊顶栏「提醒」按钮点开后打开。
 *
 * 只负责外壳（遮罩 / 标题栏 / 页脚）；编辑逻辑见 {@link GroupKeywordEditor}，
 * 它会自己防抖写回并在卸载时落盘，所以这里点「完成」直接关就行。
 */
export function GroupKeywordDialog({
  groupId,
  groupName,
  members,
  onClose,
}: {
  groupId: string;
  groupName: string;
  members: KeywordMember[];
  onClose: () => void;
}): ReactElement {
  const [saveState, setSaveState] = useState({ saving: false, savedAt: 0 });

  useEscapeToClose(onClose);

  return (
    <div
      className="modal-scrim group-keyword-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="group-keyword-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div className="group-keyword-title">
            <span className="group-keyword-title-icon">
              <BellRing size={17} />
            </span>
            <div>
              <strong>群关键词提醒</strong>
              <span>{groupName}</span>
            </div>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="group-keyword-body">
          <GroupKeywordEditor groupId={groupId} members={members} onSaveState={setSaveState} />
        </div>

        <footer className="group-keyword-foot">
          <span className="group-keyword-save-state">
            {saveState.saving ? '保存中…' : saveState.savedAt ? '已保存' : ''}
          </span>
          <button type="button" className="group-keyword-done" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
