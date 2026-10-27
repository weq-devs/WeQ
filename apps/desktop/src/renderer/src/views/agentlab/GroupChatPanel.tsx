/**
 * 克隆群聊的数据源与设置适配：聊天页面唯一实现为普通 ChatPane。
 *
 * 发一条消息 → 后端让「被 @ 或全部」克隆体各回 → 每条回复经 account.onGroupChatEvent
 * 流式推来，投影为普通 Message / Conversation 后交给共用时间线。
 * @ 选择：输入 @ 弹出成员浮层，选中插入 @名字；发送时按文本里出现的 @名字 推出 mentions。
 *
 * 事件按 groupId 过滤（而非事后才拿到的
 * groupRunId），避免「用户那条消息比 mutation 响应更早到达」的竞态把它漏掉。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Trash2, Users, UserMinus, UserPlus, Settings2 } from 'lucide-react';
import { ChatPane } from '../../im-template/template/chatPane';
import { ChatRecordsModal } from '../../components/search/ChatRecordsModal';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import { trpc, client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { ConversationSettingsFrame } from '../../components/ConversationSettingsFrame';
import { QqAvatar } from '../../components/QqAvatar';
import { AgentMessageContent, inputFaceContext, type FaceContext } from './ChatBubble';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
  cloneChatInput,
} from './cloneChatAdapter';
import { SessionSwitcher } from './SessionSwitcher';
import { AddGroupMembersModal, type AddGroupMembersResult } from './AddGroupMembersModal';
import type { AgentLabGroupMessage } from '@weq/agentlab';
import type { GeneratedSearchHit } from '../../components/search/types';
import '../../styles/clone-group-members.css';

interface PersonaLite {
  id: string;
  name: string;
  sourceId: string;
  /** 后端随 persona 下发的头像用 QQ 号；好友资料查不到时兜底。 */
  sourceUin?: string;
  systemFaces?: string[] | null;
}

export function GroupChatPanel({
  groupId,
  sessionId,
  searchTarget,
  readOnlyLegacy = false,
  selfUin,
  personaList,
  profileByUid,
  faceDescToId,
  onBack,
  onDeleted,
  onSessionCreated,
  onSwitchSession,
  onNewSession,
  onOpenPersonaSettings,
  personaSettingsOpen = false,
}: {
  groupId: string;
  /** 真实会话 id；null = 草稿会话（首条消息才落库建会话）。 */
  sessionId: string | null;
  searchTarget?: GeneratedSearchHit;
  readOnlyLegacy?: boolean;
  selfUin?: string;
  personaList: PersonaLite[];
  profileByUid: Map<string, { uin: string; label: string; avatarUrl?: string }>;
  faceDescToId: Map<string, number>;
  onBack: () => void;
  onDeleted: () => void;
  /** 草稿会话首条消息落库后回调（父组件把选中态指向新会话，不换 key）。 */
  onSessionCreated: (sessionId: string) => void;
  /** 切到同一群的另一段会话。 */
  onSwitchSession: (sessionId: string) => void;
  onNewSession: () => void;
  onOpenPersonaSettings?: (personaId: string) => void;
  personaSettingsOpen?: boolean;
}): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const detail = trpc.account.getAgentLabGroupDetail.useQuery({ groupId });
  const sessionList = trpc.account.listAgentLabGroupSessions.useQuery(
    { groupId },
    { staleTime: 0 },
  );
  // 当前真实会话 id：null = 草稿。草稿升级成真会话时更新状态，让 conversation 查询
  // 从「禁用」变为「按新会话拉取」——事件流万一漏了几条也能从磁盘补齐（不依赖重挂载）。
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(sessionId);
  const sessionIdRef = useRef<string | null>(sessionId);
  const legacy = readOnlyLegacy || Boolean(searchTarget && searchTarget.sessionId === null);
  // 每次进群都从磁盘拉最新：订阅是组件级的，若在流式途中/ done 前切走，done 的 invalidate
  // 不会执行（订阅已销毁），只靠事件刷缓存会漏。强制 refetch + 按 id 合并 = 无论漏没漏都补齐。
  const conversation = trpc.account.getAgentLabGroupConversation.useQuery(
    { groupId, sessionId: currentSessionId ?? undefined },
    { refetchOnMount: 'always', staleTime: 0, enabled: !!currentSessionId || legacy },
  );
  const send = trpc.account.sendAgentLabGroupMessage.useMutation();
  const clear = trpc.account.clearAgentLabGroupConversation.useMutation();
  const createSession = trpc.account.createAgentLabGroupSession.useMutation();
  const deleteSession = trpc.account.deleteAgentLabGroupSession.useMutation();
  const del = trpc.account.deleteAgentLabGroup.useMutation();
  const addMember = trpc.account.addAgentLabGroupMember.useMutation();
  const removeMember = trpc.account.removeAgentLabGroupMember.useMutation();

  const [history, setHistory] = useState<AgentLabGroupMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [addingMembers, setAddingMembers] = useState(false);
  const [addingMembersBusy, setAddingMembersBusy] = useState(false);
  const addingMember = useRef(false);
  const removingMember = useRef(false);
  const [settingsSection, setSettingsSection] = useState<'members' | 'management'>('members');
  const seenIds = useRef<Set<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [memberSearchKeyword, setMemberSearchKeyword] = useState('');
  const [jumpRequest, setJumpRequest] = useState(
    searchTarget ? { messageId: searchTarget.messageId, revision: 0 } : undefined,
  );
  const viewId = useRef(`virtual:clone:group:${groupId}:${sessionId ?? 'draft'}`).current;
  const user = useMemo(() => cloneChatUser('self', '我', selfUin), [selfUin]);

  const members = detail.data?.members ?? [];
  const personaMembers = useMemo(() => members.filter((m) => m.kind === 'persona'), [members]);
  const userFaces = useMemo(() => inputFaceContext(faceDescToId), [faceDescToId]);
  const personasById = useMemo(
    () => new Map(personaList.map((persona) => [persona.id, persona])),
    [personaList],
  );

  // 解析源身份与生成内容，头像、气泡和消息操作由普通页面负责。
  const metaFor = useCallback(
    (
      senderId: string,
      senderKind: 'user' | 'persona',
      fallbackName: string,
    ): { name: string; uin?: string; bot: boolean; personaId?: string; faces?: FaceContext } => {
      if (senderKind === 'user') return { name: '我', uin: selfUin, bot: false, faces: userFaces };
      const p = personasById.get(senderId);
      const uin = p ? profileByUid.get(p.sourceId)?.uin || p.sourceUin : undefined;
      const faces: FaceContext | undefined = p?.systemFaces?.length
        ? { whitelist: p.systemFaces, descToId: faceDescToId }
        : undefined;
      return { name: p?.name ?? fallbackName, uin, bot: true, personaId: senderId, faces };
    },
    [personasById, profileByUid, faceDescToId, selfUin, userFaces],
  );
  const nameById = useMemo(
    () => new Map(members.map((m) => [m.memberId, m.displayName])),
    [members],
  );

  // 把持久化群消息合并进本地历史：按 id 去重、只补不删（流式已在的不动）、按时间排序。
  // 这样切走再切回 / 漏事件时都能从磁盘补齐，不会像「只 seed 一次」那样卡在陈旧缓存上。
  useEffect(() => {
    const data = conversation.data;
    if (searchTarget && conversation.isFetching) return;
    if (!data || data.length === 0) return;
    const missing = data.filter((m) => !seenIds.current.has(m.id));
    if (missing.length === 0) return;
    missing.forEach((m) => {
      seenIds.current.add(m.id);
    });
    setHistory((prev) => [...prev, ...missing].sort((a, b) => a.ts - b.ts));
  }, [conversation.data, conversation.isFetching, searchTarget]);

  // 订阅处理器里要用 dialog / utils，但它们每次渲染都是新对象；直接进依赖会让订阅
  // 每帧重建（unsubscribe + 重新 subscribe），事件恰好落在空窗期就丢了 → 用 ref 拿最新实现。
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const utilsRef = useRef(utils);
  utilsRef.current = utils;

  // 群聊事件流：按 groupId 过滤，逐条追加（id 去重防重复事件）。
  useEffect(() => {
    if (legacy) return undefined;
    const sub = client.account.onGroupChatEvent.subscribe(undefined, {
      onData: (ev) => {
        if (ev.groupId !== groupId) return;
        if (ev.kind === 'message') {
          if (seenIds.current.has(ev.message.id)) return;
          seenIds.current.add(ev.message.id);
          setHistory((prev) => [...prev, ev.message]);
          void utilsRef.current.account.listAgentLabGroups.invalidate();
        } else if (ev.kind === 'done') {
          setBusy(false);
          // 让持久化群消息缓存跟上（后端已逐条落库）；否则切走再切回会从陈旧缓存 reseed 丢消息。
          const sid = sessionIdRef.current;
          void utilsRef.current.account.getAgentLabGroupConversation.invalidate({
            groupId,
            ...(sid ? { sessionId: sid } : {}),
          });
          // 首句标题 / 时间刷新由后端落库，这里让会话列表跟上。
          void utilsRef.current.account.listAgentLabGroupSessions.invalidate({ groupId });
          void utilsRef.current.account.listAgentLabGroups.invalidate();
        } else if (ev.kind === 'error') {
          setBusy(false);
          dialogRef.current.error('群聊出错', ev.message);
        }
      },
      onError: (err) => console.error('[groupchat] event subscription error', err),
    });
    return () => sub.unsubscribe();
    // 只按 groupId 过滤，其余状态全走 ref / 稳定 setter —— 订阅建一次即可，不随渲染重建。
  }, [groupId, legacy]);

  async function onSend(body: string): Promise<void> {
    if (legacy) return;
    const text = cloneChatInput(body, faceDescToId).trim();
    if (!text || busy) return;
    setJumpRequest(undefined);
    // 文本里出现 @某克隆体名 → 定向 @；一个都没有 → 全体应答（后端逻辑）。
    const mentions = personaMembers
      .filter((m) => text.includes(`@${m.displayName}`))
      .map((m) => m.memberId);
    setInput('');
    setBusy(true);
    try {
      // 草稿会话：真正发第一条消息时才落库建会话（与 WeQ 助手一致）。
      let sid = sessionIdRef.current;
      if (!sid) {
        const session = await createSession.mutateAsync({ groupId });
        sid = session.id;
        sessionIdRef.current = sid;
        // 把查询切到新会话：查询变为 enabled，事件流万一漏发也能从磁盘把已落库消息合并回来。
        setCurrentSessionId(sid);
        await utils.account.listAgentLabGroupSessions.invalidate({ groupId });
        onSessionCreated(sid);
      }
      await send.mutateAsync({ groupId, text, mentions, sessionId: sid });
      // 用户消息与所有回复都由 onGroupChatEvent 流式送达，这里不做乐观插入（避免重复）。
      // 发送完成后立刻从磁盘刷一次：漏掉的事件对应的消息已落库，合并 effect 会按 id 补齐。
      void utils.account.getAgentLabGroupConversation.invalidate({
        groupId,
        sessionId: sid,
      });
    } catch (e) {
      setBusy(false);
      dialog.error('发送失败', e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      // 事件漏发或生成失败时，也从落库消息恢复主列表的活动时间和预览。
      void utils.account.listAgentLabGroups.invalidate();
    }
  }

  async function onClear(): Promise<void> {
    if (legacy) return;
    const ok = await dialog.confirm(
      '清空当前对话',
      '仅清空当前这段群聊对话的消息，保留其他历史对话、群聊和成员。此操作无法恢复。',
      {
        okLabel: '清空',
        tone: 'warning',
      },
    );
    if (!ok) return;
    const sid = sessionIdRef.current;
    if (sid) {
      await clear.mutateAsync({ groupId, sessionId: sid });
      await utils.account.getAgentLabGroupConversation.invalidate({ groupId, sessionId: sid });
    }
    setHistory([]);
    seenIds.current.clear();
  }

  async function onAddMembers(personaIds: string[]): Promise<AddGroupMembersResult> {
    if (busy || addingMember.current)
      return { addedIds: [], error: '当前无法添加成员，请稍后重试。' };
    addingMember.current = true;
    setAddingMembersBusy(true);
    const result: AddGroupMembersResult = { addedIds: [] };
    try {
      for (const personaId of personaIds) {
        try {
          await addMember.mutateAsync({ groupId, personaId });
          result.addedIds.push(personaId);
        } catch (cause) {
          const name = personaList.find((persona) => persona.id === personaId)?.name ?? '成员';
          result.error = `添加「${name}」失败：${cause instanceof Error ? cause.message : String(cause)}`;
          break;
        }
      }
      if (result.addedIds.length > 0) {
        try {
          await Promise.all([
            utils.account.getAgentLabGroupDetail.invalidate({ groupId }),
            utils.account.listAgentLabGroups.invalidate(),
          ]);
        } catch {
          result.error = `${result.error ? `${result.error}。` : ''}已添加的成员已生效，但列表刷新失败，请稍后重新打开群聊。`;
        }
      }
      return result;
    } finally {
      addingMember.current = false;
      setAddingMembersBusy(false);
    }
  }

  async function onKickMember(memberId: string): Promise<void> {
    if (busy || removingMember.current) return;
    const member = members.find((item) => item.kind === 'persona' && item.memberId === memberId);
    if (!member) return;
    removingMember.current = true;
    try {
      if (
        !(await dialog.confirm(
          '移除成员',
          `将 ${member.displayName} 移出当前群聊？不会删除克隆体或私聊记录。`,
          { okLabel: '移除', tone: 'warning' },
        ))
      )
        return;
      await removeMember.mutateAsync({ groupId, memberId });
      await Promise.all([
        utils.account.getAgentLabGroupDetail.invalidate({ groupId }),
        utils.account.listAgentLabGroups.invalidate(),
      ]);
    } catch (e) {
      dialog.error('移除失败', e instanceof Error ? e.message : String(e));
    } finally {
      removingMember.current = false;
    }
  }

  const memberOptions = useMemo(() => {
    const options = personaList.map((persona) => ({
      id: persona.id,
      name: persona.name,
      uin: profileByUid.get(persona.sourceId)?.uin || persona.sourceUin,
    }));
    for (const member of personaMembers) {
      if (!options.some((option) => option.id === member.memberId))
        options.push({ id: member.memberId, name: member.displayName, uin: undefined });
    }
    return options;
  }, [personaList, personaMembers, profileByUid]);

  async function onDelete(): Promise<void> {
    const ok = await dialog.confirm(
      '删除整个群聊',
      '删除这个克隆群及其全部历史对话。不会删除成员对应的克隆体。此操作无法恢复。',
      {
        okLabel: '删除',
        tone: 'warning',
      },
    );
    if (!ok) return;
    await del.mutateAsync({ groupId });
    await utils.account.listAgentLabGroups.invalidate();
    onDeleted();
  }

  const groupName = detail.data?.group.name ?? '群聊';
  const chatConversation = useMemo(() => {
    const projected = cloneChatConversation({
      target: { kind: 'group', ownerId: groupId, sessionId: legacy ? null : currentSessionId },
      viewId,
      name: groupName,
      peer: user,
      members: [
        user,
        ...personaMembers.map((member) => {
          const meta = metaFor(member.memberId, 'persona', member.displayName);
          return cloneChatUser(member.memberId, meta.name, meta.uin, true);
        }),
      ],
    });
    if (projected.type === 'group') {
      const createdAt = detail.data?.group.createdAt;
      projected.group.createTime = createdAt ? new Date(createdAt).toISOString() : null;
      projected.members = projected.members.map((member) => {
        const source = members.find(
          (item) =>
            `virtual:${item.memberId}` === member.id ||
            (item.kind === 'user' && member.id === user.id),
        );
        return {
          ...member,
          joinedAt: source?.joinedAt ? new Date(source.joinedAt).toISOString() : '',
        };
      });
    }
    return projected;
  }, [
    groupId,
    legacy,
    currentSessionId,
    viewId,
    groupName,
    user,
    personaMembers,
    metaFor,
    detail.data?.group.createdAt,
    members,
  ]);
  const memberSearch = useMemo(() => {
    const keyword = memberSearchKeyword.trim().toLocaleLowerCase();
    const matches = chatConversation.members.filter((member) =>
      [
        member.displayName,
        member.username,
        member.nick,
        member.card,
        member.remark,
        member.uin,
        member.identityValue,
      ].some((value) => value?.toLocaleLowerCase().includes(keyword)),
    );
    return {
      keyword: memberSearchKeyword,
      members: matches,
      total: matches.length,
      loading: false,
      loadingMore: false,
      hasMore: false,
      error: null,
    };
  }, [chatConversation.members, memberSearchKeyword]);
  const messages = useMemo(
    () =>
      cloneChatMessages(history, viewId, (index) => {
        const row = history[index]!;
        if (row.senderKind === 'user') return user;
        const meta = metaFor(row.senderId, 'persona', nameById.get(row.senderId) ?? '克隆体');
        return cloneChatUser(row.senderId, meta.name, meta.uin, true);
      }),
    [history, viewId, user, metaFor, nameById],
  );
  const sourceMessages = useMemo(
    () => new Map(history.map((message) => [message.id, message])),
    [history],
  );
  const renderers = useMemo<MessageRenderer[]>(
    () => [
      {
        id: 'generated-content',
        match: () => true,
        render: ({ message, mine }) => {
          const source = sourceMessages.get(message.id);
          const meta = source
            ? metaFor(source.senderId, source.senderKind, nameById.get(source.senderId) ?? '克隆体')
            : undefined;
          return (
            <AgentMessageContent
              text={message.body}
              personaId={mine ? undefined : source?.senderId}
              faces={meta?.faces}
            />
          );
        },
      },
    ],
    [sourceMessages, metaFor, nameById],
  );
  return (
    <>
      <ChatPane
        loadError={conversation.isError ? '记录加载失败' : undefined}
        user={user}
        conversation={chatConversation}
        onKickGroupMember={(_conversation, sender) => {
          const member = members.find(
            (item) => item.kind === 'persona' && `virtual:${item.memberId}` === sender.id,
          );
          if (member) void onKickMember(member.memberId);
        }}
        groupMemberSearch={memberSearch}
        onGroupMemberSearchChange={setMemberSearchKeyword}
        onAddGroupMember={() => {
          setAddingMembers(true);
        }}
        profileLoading={detail.isLoading}
        groupMembersError={detail.isError ? '群成员加载失败' : undefined}
        messages={messages}
        messageRenderers={renderers}
        loading={Boolean(
          conversation.isFetching && !history.length && (currentSessionId || legacy),
        )}
        preference={undefined}
        draft={input}
        onDraftChange={(_id, value) => setInput(value)}
        onDraftClear={() => setInput('')}
        onSend={onSend}
        onBack={onBack}
        sendAvailable={!legacy && !busy}
        readOnly={legacy}
        sendBlockedReason={legacy ? '旧版对话（只读）' : '克隆体正在回复'}
        settingsLabel="克隆群聊设置"
        onOpenConversationSettings={() => setMembersOpen(true)}
        onSearchChatRecords={() => setSearchOpen(true)}
        jumpRequest={jumpRequest}
        headerActions={
          <SessionSwitcher
            sessions={sessionList.data ?? []}
            activeSessionId={currentSessionId}
            draft={!legacy && !currentSessionId}
            loading={sessionList.isLoading}
            disabled={legacy}
            compact
            onSwitch={onSwitchSession}
            onNew={onNewSession}
            onClear={
              !legacy && currentSessionId
                ? () =>
                    void onClear().catch((error: unknown) =>
                      dialog.error('清空失败', String(error)),
                    )
                : undefined
            }
            clearDisabled={busy || clear.isLoading}
            onDelete={(target) => {
              void (async () => {
                if (
                  !(await dialog.confirm('删除会话', '确认删除这段对话？删除后无法恢复。', {
                    okLabel: '删除',
                    tone: 'warning',
                  }))
                )
                  return;
                await deleteSession.mutateAsync({ groupId, sessionId: target });
                await utils.account.listAgentLabGroupSessions.invalidate({ groupId });
                if (currentSessionId === target) onNewSession();
              })();
            }}
          />
        }
      />
      {searchOpen ? (
        <ChatRecordsModal
          fixed
          initialKeyword=""
          initialHit={{
            category: 'chatRecord',
            source: 'group',
            partition: viewId,
            targetUid: viewId,
            targetUin: '',
            name: groupName,
            count: messages.length,
          }}
          renderers={renderers}
          localSource={{
            conversation: chatConversation,
            messages,
            user,
            onJump: (id) =>
              setJumpRequest((request) => ({
                messageId: id,
                revision: (request?.revision ?? 0) + 1,
              })),
          }}
          onClose={() => setSearchOpen(false)}
          onJumpMessage={() => {}}
        />
      ) : null}

      {addingMembers ? (
        <AddGroupMembersModal
          groupName={groupName}
          personas={memberOptions}
          memberIds={personaMembers.map((member) => member.memberId)}
          loading={detail.isLoading || detail.isFetching}
          loadError={detail.isError ? '成员列表加载失败，请重新进入群聊后重试。' : undefined}
          blocked={busy}
          onAdd={onAddMembers}
          onClose={() => setAddingMembers(false)}
        />
      ) : null}
      {/* 添加弹窗覆盖设置窗，保留实例以维持原锚点和滚动位置。 */}
      {membersOpen && !personaSettingsOpen ? (
        <ConversationSettingsFrame<'members' | 'management'>
          title="克隆群聊设置"
          subtitle={groupName}
          value={settingsSection}
          onValueChange={setSettingsSection}
          onClose={() => setMembersOpen(false)}
          sections={[
            { id: 'members', label: '群成员', icon: <Users size={16} /> },
            { id: 'management', label: '群聊管理', icon: <Settings2 size={16} /> },
          ]}
        >
          <div className="weq-cvs-body-head">
            <span className="weq-cvs-body-icon">
              {settingsSection === 'members' ? <Users size={16} /> : <Settings2 size={16} />}
            </span>
            <strong>{settingsSection === 'members' ? '群成员' : '群聊管理'}</strong>
          </div>
          <div className="weq-cvs-body-scroll">
            {settingsSection === 'members' ? (
              <div className="weq-agentlab-field">
                <div className="weq-clone-member-toolbar">
                  <span>群内克隆体（{personaMembers.length}）</span>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    aria-haspopup="dialog"
                    onClick={() => setAddingMembers(true)}
                  >
                    <UserPlus size={14} />
                    添加成员
                  </button>
                </div>
                <p className="weq-persona-note">
                  成员变更确认后生效；成员配置由该克隆体的所有私聊和群聊共用。
                </p>
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
                          {onOpenPersonaSettings && personasById.has(m.memberId) ? (
                            <button
                              type="button"
                              className="weq-persona-memforget"
                              title={`设置克隆体 ${m.displayName}`}
                              onClick={() => onOpenPersonaSettings(m.memberId)}
                            >
                              <Settings2 size={14} />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="weq-persona-memforget"
                            title="移出当前群（保留克隆体）"
                            disabled={busy || removeMember.isLoading || addingMembersBusy}
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
            ) : (
              <div className="weq-persona-form">
                <p className="weq-persona-note">
                  删除整个群及全部历史对话，不会删除成员对应的克隆体。仅清空或删除某段对话请使用标题栏的历史会话菜单。
                </p>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={busy || del.isLoading}
                  onClick={() =>
                    void onDelete().catch((error: unknown) =>
                      dialog.error('删除失败', String(error)),
                    )
                  }
                >
                  <Trash2 size={14} />
                  删除整个群聊
                </button>
              </div>
            )}
          </div>
        </ConversationSettingsFrame>
      ) : null}
    </>
  );
}
