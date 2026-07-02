/**
 * 克隆体群聊面板：多个克隆体 + 「我」同处一室。
 *
 * 发一条消息 → 后端让「被 @ 或全部」克隆体各回 → 每条回复经 account.onGroupChatEvent
 * 流式推来，按 senderId 分气泡逐条揭示（复用 ChatBubble 的头像/名字/表情/语音渲染）。
 * @ 选择：输入 @ 弹出成员浮层，选中插入 @名字；发送时按文本里出现的 @名字 推出 mentions。
 *
 * M2 群骨架：还没有意愿 gate / 关系 / 连锁（M3–M6）。事件按 groupId 过滤（而非事后才拿到的
 * groupRunId），避免「用户那条消息比 mutation 响应更早到达」的竞态把它漏掉。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowLeft, AtSign, Send, Trash2, Users, UserMinus, UserPlus, X } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { autoGrowTextarea } from '../../lib/textareaAutoGrow';
import { Modal } from '../../components/Dialog';
import { QqAvatar } from '../../components/QqAvatar';
import { ChatBubble, type FaceContext } from './ChatBubble';
import type { AgentLabGroupMessage } from '@weq/agentlab';

interface PersonaLite {
  id: string;
  name: string;
  sourceId: string;
  systemFaces?: string[] | null;
}

export function GroupChatPanel({
  groupId,
  selfUin,
  personaList,
  profileByUid,
  faceDescToId,
  onBack,
  onDeleted,
}: {
  groupId: string;
  selfUin?: string;
  personaList: PersonaLite[];
  profileByUid: Map<string, { uin: string; label: string; avatarUrl?: string }>;
  faceDescToId: Map<string, number>;
  onBack: () => void;
  onDeleted: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const detail = trpc.account.getAgentLabGroupDetail.useQuery({ groupId });
  // 每次进群都从磁盘拉最新：订阅是组件级的，若在流式途中/ done 前切走，done 的 invalidate
  // 不会执行（订阅已销毁），只靠事件刷缓存会漏。强制 refetch + 按 id 合并 = 无论漏没漏都补齐。
  const conversation = trpc.account.getAgentLabGroupConversation.useQuery(
    { groupId },
    { refetchOnMount: 'always', staleTime: 0 },
  );
  const send = trpc.account.sendAgentLabGroupMessage.useMutation();
  const clear = trpc.account.clearAgentLabGroupConversation.useMutation();
  const del = trpc.account.deleteAgentLabGroup.useMutation();
  const addMember = trpc.account.addAgentLabGroupMember.useMutation();
  const removeMember = trpc.account.removeAgentLabGroupMember.useMutation();

  const [history, setHistory] = useState<AgentLabGroupMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const members = detail.data?.members ?? [];
  const personaMembers = useMemo(() => members.filter((m) => m.kind === 'persona'), [members]);

  // 解析发送者 → 头像/名字/表情上下文（复用 ChatBubble）。
  const metaFor = (
    senderId: string,
    senderKind: 'user' | 'persona',
    fallbackName: string,
  ): { name: string; uin?: string; bot: boolean; personaId?: string; faces?: FaceContext } => {
    if (senderKind === 'user') return { name: '我', uin: selfUin, bot: false };
    const p = personaList.find((x) => x.id === senderId);
    const uin = p ? profileByUid.get(p.sourceId)?.uin : undefined;
    const faces: FaceContext | undefined = p?.systemFaces?.length
      ? { whitelist: p.systemFaces, descToId: faceDescToId }
      : undefined;
    return { name: p?.name ?? fallbackName, uin, bot: true, personaId: senderId, faces };
  };
  const nameById = useMemo(() => new Map(members.map((m) => [m.memberId, m.displayName])), [members]);

  function scrollToBottom(): void {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // 把持久化群消息合并进本地历史：按 id 去重、只补不删（流式已在的不动）、按时间排序。
  // 这样切走再切回 / 漏事件时都能从磁盘补齐，不会像「只 seed 一次」那样卡在陈旧缓存上。
  useEffect(() => {
    const data = conversation.data;
    if (!data || data.length === 0) return;
    const missing = data.filter((m) => !seenIds.current.has(m.id));
    if (missing.length === 0) return;
    missing.forEach((m) => seenIds.current.add(m.id));
    setHistory((prev) => [...prev, ...missing].sort((a, b) => a.ts - b.ts));
  }, [conversation.data]);

  // 群聊事件流：按 groupId 过滤，逐条追加（id 去重防重复事件）。
  useEffect(() => {
    const sub = client.account.onGroupChatEvent.subscribe(undefined, {
      onData: (ev) => {
        if (ev.groupId !== groupId) return;
        if (ev.kind === 'message') {
          if (seenIds.current.has(ev.message.id)) return;
          seenIds.current.add(ev.message.id);
          setHistory((prev) => [...prev, ev.message]);
        } else if (ev.kind === 'done') {
          setBusy(false);
          // 让持久化群消息缓存跟上（后端已逐条落库）；否则切走再切回会从陈旧缓存 reseed 丢消息。
          void utils.account.getAgentLabGroupConversation.invalidate({ groupId });
        } else if (ev.kind === 'error') {
          setBusy(false);
          dialog.error('群聊出错', ev.message);
        }
      },
      onError: (err) => console.error('[groupchat] event subscription error', err),
    });
    return () => sub.unsubscribe();
  }, [groupId, dialog]);

  useEffect(() => {
    scrollToBottom();
  }, [history, busy]);

  // 输入框末尾的 @token（@ 后到光标、无空格）→ 驱动成员浮层。
  const mentionQuery = useMemo(() => {
    const m = input.match(/@([^@\s]*)$/);
    return m ? (m[1] ?? '') : null;
  }, [input]);
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return personaMembers.filter((m) => !q || m.displayName.toLowerCase().includes(q));
  }, [mentionQuery, personaMembers]);

  function pickMention(displayName: string): void {
    // 用 @名字 + 空格 替换末尾的 @token。
    setInput((cur) => cur.replace(/@([^@\s]*)$/, `@${displayName} `));
    inputRef.current?.focus();
  }

  async function onSend(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    // 文本里出现 @某克隆体名 → 定向 @；一个都没有 → 全体应答（后端逻辑）。
    const mentions = personaMembers.filter((m) => text.includes(`@${m.displayName}`)).map((m) => m.memberId);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setBusy(true);
    try {
      await send.mutateAsync({ groupId, text, mentions });
      // 用户消息与所有回复都由 onGroupChatEvent 流式送达，这里不做乐观插入（避免重复）。
    } catch (e) {
      setBusy(false);
      dialog.error('发送失败', e instanceof Error ? e.message : String(e));
      setInput(text);
    }
  }

  async function onClear(): Promise<void> {
    const ok = await dialog.confirm('清空群聊', '确认清空这个群的聊天记录？', { okLabel: '清空', tone: 'warning' });
    if (!ok) return;
    await clear.mutateAsync({ groupId });
    setHistory([]);
    seenIds.current.clear();
    await utils.account.getAgentLabGroupConversation.invalidate({ groupId });
  }

  async function onAddMember(personaId: string): Promise<void> {
    try {
      await addMember.mutateAsync({ groupId, personaId });
      await utils.account.getAgentLabGroupDetail.invalidate({ groupId });
    } catch (e) {
      dialog.error('添加失败', e instanceof Error ? e.message : String(e));
    }
  }

  async function onKickMember(memberId: string): Promise<void> {
    try {
      await removeMember.mutateAsync({ groupId, memberId });
      await utils.account.getAgentLabGroupDetail.invalidate({ groupId });
    } catch (e) {
      dialog.error('移除失败', e instanceof Error ? e.message : String(e));
    }
  }

  // 还没进群的克隆体（可添加）。
  const outsiders = useMemo(
    () => personaList.filter((p) => !members.some((m) => m.memberId === p.id)),
    [personaList, members],
  );

  async function onDelete(): Promise<void> {
    const ok = await dialog.confirm('删除群聊', '确认删除这个群聊？聊天记录会一并删除。', {
      okLabel: '删除',
      tone: 'warning',
    });
    if (!ok) return;
    await del.mutateAsync({ groupId });
    await utils.account.listAgentLabGroups.invalidate();
    onDeleted();
  }

  const groupName = detail.data?.group.name ?? '群聊';

  return (
    <div className="weq-agentlab-chat">
      <header className="weq-agentlab-head">
        <div className="weq-agentlab-head-left">
          <button type="button" className="weq-set-iconbtn" onClick={onBack} aria-label="返回主页" title="返回">
            <ArrowLeft size={16} />
          </button>
          <div>
            <strong>{groupName}</strong>
            <span>{personaMembers.length} 个克隆体 + 我 · 共 {history.length} 条</span>
          </div>
        </div>
        <div className="weq-agentlab-head-actions">
          <button type="button" className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => setMembersOpen(true)}>
            <Users size={12} />
            成员
          </button>
          <button type="button" className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => void onClear()}>
            清空
          </button>
          <button type="button" className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => void onDelete()}>
            <Trash2 size={12} />
            删除
          </button>
        </div>
      </header>

      <div className="weq-agentlab-transcript" ref={transcriptRef}>
        {history.length === 0 ? (
          <div className="weq-agentlab-empty">
            这是一个群聊，有 {personaMembers.map((m) => m.displayName).join('、') || '（暂无克隆体）'}。
            发一句话试试，或用 @ 点名某个克隆体。
          </div>
        ) : (
          history.map((m, index) => {
            const meta = metaFor(m.senderId, m.senderKind, nameById.get(m.senderId) ?? '克隆体');
            return (
              <ChatBubble
                key={m.id || `${m.senderId}-${index}`}
                mine={m.senderKind === 'user'}
                bot={meta.bot}
                name={meta.name}
                uin={meta.uin}
                text={m.text}
                faces={meta.faces}
                personaId={meta.personaId}
                onMediaLoad={scrollToBottom}
              />
            );
          })
        )}
      </div>

      <div className="weq-agentlab-composer">
        {mentionCandidates.length > 0 ? (
          <div className="weq-mention-pop">
            {mentionCandidates.map((m) => (
              <button
                key={m.memberId}
                type="button"
                className="weq-mention-opt"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(m.displayName);
                }}
              >
                <AtSign size={12} />
                {m.displayName}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoGrowTextarea(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder="在群里说点什么（@ 点名克隆体，Enter 发送，Shift+Enter 换行）"
          disabled={busy}
        />
        <button type="button" className="weq-set-btn" onClick={() => void onSend()} disabled={busy || !input.trim()}>
          <Send size={14} />
          发送
        </button>
      </div>

      {membersOpen ? (
        <Modal onClose={() => setMembersOpen(false)} width={460} labelledBy="weq-group-members-title">
          <div className="weq-clone-modal">
            <header className="weq-clone-modal-head">
              <Users size={18} />
              <strong id="weq-group-members-title">{groupName} · 成员</strong>
            </header>
            <div className="weq-clone-config">
              <div className="weq-agentlab-field">
                <span>群内克隆体（{personaMembers.length}）</span>
                <div className="weq-group-members">
                  {personaMembers.length === 0 ? (
                    <div className="weq-agentlab-empty">群里还没有克隆体。</div>
                  ) : (
                    personaMembers.map((m) => {
                      const meta = metaFor(m.memberId, 'persona', m.displayName);
                      return (
                        <div key={m.memberId} className="weq-group-member">
                          <QqAvatar uin={meta.uin} size={34} />
                          <span className="weq-group-member-text">
                            <strong>{m.displayName}</strong>
                          </span>
                          <button
                            type="button"
                            className="weq-persona-memforget"
                            title="踢出群聊"
                            onClick={() => void onKickMember(m.memberId)}
                          >
                            <UserMinus size={14} />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {outsiders.length > 0 ? (
                <div className="weq-agentlab-field">
                  <span>添加克隆体</span>
                  <div className="weq-group-members">
                    {outsiders.map((p) => (
                      <div key={p.id} className="weq-group-member">
                        <QqAvatar uin={profileByUid.get(p.sourceId)?.uin} size={34} />
                        <span className="weq-group-member-text">
                          <strong>{p.name}</strong>
                        </span>
                        <button
                          type="button"
                          className="weq-persona-memforget"
                          title="加入群聊"
                          onClick={() => void onAddMember(p.id)}
                        >
                          <UserPlus size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="weq-clone-actions">
                <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={() => setMembersOpen(false)}>
                  <X size={13} /> 关闭
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
