// @ts-nocheck
/**
 * 群关键词提醒设置灯箱 —— 群聊顶栏的「提醒」按钮点开后打开。
 *
 * 结构：
 *   - 关键词：输入回车加一个词，可多个；chip 上带删除；
 *   - 指定成员：可搜索添加，或一键「群主」/「全部管理员」；不指定 = 全部成员。
 *
 * 规则写到本地（主进程 user config，落盘叫 keyword rules），主进程按它匹配新到达的
 * 群消息。这里只管读写这份配置，不碰任何消息库。整体视觉沿用群公告灯箱那套
 * （主题色 / 深浅模式自动跟随）。
 *
 * 保存时机：改动后**防抖写回**（免得每敲一个字打一次 IPC），关闭时再 `flush` 一次 ——
 * 否则「加完词立刻点完成」会落在防抖窗口里被丢掉。
 */

import { BellRing, Crown, Search, ShieldCheck, X } from 'lucide-react';
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

type RuleMap = Record<string, { keywords: string[]; memberUids: string[] }>;

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
  const [keywords, setKeywords] = useState<string[]>([]);
  const [memberUids, setMemberUids] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const rulesRef = useRef<RuleMap>({});
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  // 最新草稿的镜像：防抖回调 / flush 都在闭包外读它，避免拿到过期的 state。
  const draftRef = useRef<{ keywords: string[]; memberUids: string[] }>({
    keywords: [],
    memberUids: [],
  });

  // 读当前全部规则（保留其它群的），取本群那份作为草稿。
  useEffect(() => {
    let cancelled = false;
    client.bootstrap.getSettings
      .query()
      .then((settings) => {
        if (cancelled) return;
        const rules: RuleMap = settings?.groupKeyword?.rules ?? {};
        rulesRef.current = rules;
        const mine = rules[groupId];
        setKeywords(mine?.keywords ?? []);
        setMemberUids(mine?.memberUids ?? []);
        draftRef.current = { keywords: mine?.keywords ?? [], memberUids: mine?.memberUids ?? [] };
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const memberByUid = useMemo(() => {
    const map = new Map<string, KeywordMember>();
    for (const m of members) map.set(m.uid, m);
    return map;
  }, [members]);

  const selectedMembers = useMemo(
    () =>
      memberUids.map(
        (uid) =>
          memberByUid.get(uid) ?? {
            uid,
            displayName: uid,
            avatarUrl: null,
            role: 'member' as const,
          },
      ),
    [memberUids, memberByUid],
  );

  const searchResults = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    if (!q) return [];
    return members
      .filter((m) => !memberUids.includes(m.uid))
      .filter((m) => {
        const hay = `${m.displayName} ${m.uin ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 20);
  }, [memberQuery, members, memberUids]);

  // 把当前草稿整体写回主进程（按群号 keyed，其余群原样保留）。幂等。
  const flush = useCallback((): void => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const next: RuleMap = { ...rulesRef.current };
    const trimmed = draftRef.current.keywords.map((k) => k.trim()).filter(Boolean);
    if (trimmed.length === 0) delete next[groupId];
    else next[groupId] = { keywords: trimmed, memberUids: draftRef.current.memberUids };
    rulesRef.current = next;
    setSaving(true);
    client.bootstrap.setGroupKeywordRules
      .mutate({ rules: next })
      .then(() => setSavedAt(Date.now()))
      .catch(() => undefined)
      .finally(() => setSaving(false));
  }, [groupId]);

  // 改动后防抖写回；先同步镜像草稿，好让 flush（关闭时）总能拿到最新值。
  useEffect(() => {
    draftRef.current = { keywords, memberUids };
    if (!loaded) return undefined;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flush();
    }, 400);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [keywords, memberUids, loaded, flush]);

  // 关闭前先 flush：加完词立刻点完成 / 点遮罩 / 按 Esc 都不能丢。
  const close = useCallback((): void => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // 输入框里还没回车的词也算数 —— 用户「打完字直接点完成」是常见操作。
    const pending = draft.trim();
    if (
      pending &&
      !draftRef.current.keywords.some((k) => k.toLowerCase() === pending.toLowerCase())
    ) {
      dirtyRef.current = true;
      draftRef.current = { ...draftRef.current, keywords: [...draftRef.current.keywords, pending] };
    }
    flush();
    onClose();
  }, [flush, onClose, draft]);
  useEscapeToClose(close);

  // 每次改动都同步镜像到 draftRef，这样即使立刻点「完成」也能 flush 到最新值。
  function applyKeywords(next: string[]) {
    dirtyRef.current = true;
    draftRef.current = { ...draftRef.current, keywords: next };
    setKeywords(next);
  }

  function applyMembers(next: string[]) {
    dirtyRef.current = true;
    draftRef.current = { ...draftRef.current, memberUids: next };
    setMemberUids(next);
  }

  function addKeyword() {
    const word = draft.trim();
    if (!word) return;
    if (keywords.some((k) => k.toLowerCase() === word.toLowerCase())) {
      setDraft('');
      return;
    }
    applyKeywords([...draftRef.current.keywords, word]);
    setDraft('');
  }

  function removeKeyword(word: string) {
    applyKeywords(draftRef.current.keywords.filter((k) => k !== word));
  }

  function toggleMember(uid: string) {
    const prev = draftRef.current.memberUids;
    applyMembers(prev.includes(uid) ? prev.filter((u) => u !== uid) : [...prev, uid]);
  }

  function selectRole(role: 'owner' | 'admin') {
    const uids =
      role === 'owner'
        ? members.filter((m) => m.role === 'owner').map((m) => m.uid)
        : members.filter((m) => m.role === 'admin' || m.role === 'owner').map((m) => m.uid);
    applyMembers([...new Set([...draftRef.current.memberUids, ...uids])]);
  }

  function clearMembers() {
    applyMembers([]);
  }

  const ownerCount = members.filter((m) => m.role === 'owner').length;
  const adminCount = members.filter((m) => m.role === 'admin').length;

  return (
    <div
      className="modal-scrim group-keyword-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(close)}
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
          <button className="icon-button" type="button" title="关闭" onClick={close}>
            <X size={18} />
          </button>
        </header>

        <div className="group-keyword-body">
          <section className="group-keyword-section">
            <div className="group-keyword-label-row">
              <span className="group-keyword-label">关键词</span>
              <span className="group-keyword-desc">命中即提醒，可添加多个</span>
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
            {keywords.length > 0 ? (
              <div className="group-keyword-chips">
                {keywords.map((word) => (
                  <span key={word} className="group-keyword-chip">
                    {word}
                    <button type="button" title="删除" onClick={() => removeKeyword(word)}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="group-keyword-empty">未设置关键词，此群不会提醒</div>
            )}
          </section>

          <section className="group-keyword-section">
            <div className="group-keyword-label-row">
              <span className="group-keyword-label">指定成员</span>
              <span className="group-keyword-desc">
                不选即全部成员
                {memberUids.length > 0 ? ` · 已选 ${memberUids.length} 人` : ''}
              </span>
            </div>

            <div className="group-keyword-quick">
              <button
                type="button"
                className={cn('group-keyword-quick-btn', ownerCount === 0 && 'is-disabled')}
                disabled={ownerCount === 0}
                onClick={() => selectRole('owner')}
              >
                <Crown size={13} />
                群主
              </button>
              <button
                type="button"
                className={cn('group-keyword-quick-btn', adminCount === 0 && 'is-disabled')}
                disabled={adminCount === 0}
                onClick={() => selectRole('admin')}
              >
                <ShieldCheck size={13} />
                全部管理员
              </button>
              <button
                type="button"
                className="group-keyword-quick-btn"
                disabled={memberUids.length === 0}
                onClick={clearMembers}
              >
                清除
              </button>
            </div>

            {selectedMembers.length > 0 ? (
              <div className="group-keyword-members">
                {selectedMembers.map((m) => (
                  <span key={m.uid} className="group-keyword-member">
                    <Avatar name={m.displayName} avatarUrl={m.avatarUrl} seed={m.uid} />
                    <span className="group-keyword-member-name">{m.displayName}</span>
                    <button type="button" title="移除" onClick={() => toggleMember(m.uid)}>
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
                        toggleMember(m.uid);
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
            ) : null}
          </section>
        </div>

        <footer className="group-keyword-foot">
          <span className="group-keyword-save-state">
            {saving ? '保存中…' : savedAt ? '已保存' : ''}
          </span>
          <button type="button" className="group-keyword-done" onClick={close}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
