import { useMemo, useState } from 'react';
import { Download, RotateCw, Search, Sparkles, Users } from 'lucide-react';
import type {
  ExportSavePolicy,
  GeneratedContentTarget,
  GeneratedConversation,
  ExportOutputPlan,
} from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { WindowedList } from '../../components/WindowedList';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { useTabActive } from '../../components/RetainedTabs';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { ExportSaveActions } from '../../components/ExportSaveActions';
import { QqAvatar } from '../../components/QqAvatar';
import { ChatBubble } from '../agentlab/ChatBubble';
import { ChatTimeDivider, shouldShowChatTime } from '../agentlab/messageTime';
import { PickerListSkeleton } from './ExportSkeleton';
import {
  generatedContentContainer,
  generatedContentIdentity,
  type ContentSelection,
} from '../../../../shared/content_selection';
import { BACKEND_FORMATS, type BackendFormat } from './types';
import '../../styles/generated-export.css';

const FORMATS: BackendFormat[] = [...BACKEND_FORMATS];

/** 生成记录里的一行（渲染时用到的字段；与后端 captureGeneratedContent 对齐）。 */
interface GeneratedRow {
  id: string;
  text: string;
  ts: number;
  role?: 'user' | 'assistant';
  senderId?: string;
  senderKind?: 'user' | 'persona';
}

/** 列表行里的成员：群聊要按 senderId 显示各自的名字与头像。 */
interface MemberInfo {
  name: string;
  uin: string;
  /** 克隆体 id：给 [[sticker:...]] / [[voice:...]] 用。 */
  personaId?: string;
}

/** 头像来源：克隆体 / 克隆群 / 助手各自不同，取不到就回落到图标。 */
type AvatarInfo = { uin?: string; groupUins?: string[] };

const ME: MemberInfo = { name: '我', uin: '' };

/**
 * 克隆 / 助手对话的导出面板：
 * 左侧挑一段会话，右侧把整段对话**按聊天样式完整渲染**（头像 + 左右分栏 + 表情 / 语音 /
 * 贴纸），再按勾选导出。以前右侧只是一行行纯文本，和「对话」这个词对不上。
 */
export function GeneratedExportPane({
  initialSelection,
  prepareSave,
  isCurrent,
  onStarted,
  disabled = false,
}: {
  initialSelection?: ContentSelection;
  prepareSave: (
    intent?: ExportSavePolicy,
    output?: ExportOutputPlan,
  ) => Promise<ExportSavePolicy | null>;
  isCurrent: () => boolean;
  onStarted: () => void;
  disabled?: boolean;
}) {
  const active = useTabActive();
  const account = trpc.account.getAccountConfig.useQuery();
  const binding = {
    expectedAccountUin: account.data?.uin ?? '',
    expectedAccountConfigId: account.data?.configId ?? '',
  };
  const ready = Boolean(binding.expectedAccountUin && binding.expectedAccountConfigId);
  const [target, setTarget] = useState<GeneratedContentTarget | null>(() =>
    generatedContentIdentity(initialSelection),
  );
  const [scopes, setScopes] = useState<Record<string, string[]>>(() => {
    const identity = generatedContentIdentity(initialSelection);
    return identity && initialSelection?.scope.type === 'items'
      ? { [generatedContentContainer(identity)]: [...new Set(initialSelection.scope.ids)] }
      : {};
  });
  const [keyword, setKeyword] = useState('');
  const [formats, setFormats] = useState(new Set<BackendFormat>(['json']));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const autoRefresh = useQQAutoRefresh(active && ready);
  const sessions = trpc.account.generatedConversations.useQuery(binding, autoRefresh);
  const content = trpc.account.generatedConversation.useQuery(
    { ...binding, target: target ?? { kind: 'assistant', ownerId: 'assistant', sessionId: '_' } },
    { ...autoRefresh, enabled: autoRefresh.enabled && Boolean(target) },
  );
  // 群聊要按成员分气泡；克隆体用源好友的头像和昵称，助手固定 Sparkles。
  const groupDetail = trpc.account.getAgentLabGroupDetail.useQuery(
    { groupId: target?.kind === 'group' ? target.ownerId : '' },
    { enabled: active && target?.kind === 'group' },
  );
  // 头像与昵称的来源：会话列表和气泡都要用，所以始终拉取（只读本地 JSON）。
  const personas = trpc.account.listAgentLabPersonas.useQuery(undefined, { enabled: active });
  const groupList = trpc.account.listAgentLabGroups.useQuery(undefined, { enabled: active });
  const selfProfile = trpc.account.getSelfProfile.useQuery(undefined, { enabled: active });
  const key = target ? generatedContentContainer(target) : '';
  const ids = scopes[key];
  const rows = (content.data?.messages ?? []) as GeneratedRow[];
  const selected = new Set(ids ?? []);
  const messageMulti = useMultiSelection({
    ids: rows.map((row) => row.id),
    selected,
    onChange: (next) => setScopes((current) => ({ ...current, [key]: [...next] })),
    disabled: !target || ids === undefined || busy,
  });

  /** senderId → 显示名 / 头像。群聊按成员表，私聊只有「我 / 克隆体」。 */
  const members = useMemo(() => {
    const map = new Map<string, MemberInfo>();
    for (const persona of personas.data ?? []) {
      map.set(persona.id, {
        name: persona.name,
        uin: persona.sourceUin || '',
        personaId: persona.id,
      });
    }
    // 群成员表里有群内显示名（可能与画像名不同），以它为准。
    for (const member of groupDetail.data?.members ?? []) {
      const known = map.get(member.memberId);
      if (member.kind === 'persona')
        map.set(member.memberId, {
          name: member.displayName || known?.name || '克隆体',
          uin: known?.uin ?? '',
          personaId: member.memberId,
        });
      else if (member.kind === 'user')
        map.set(member.memberId, { name: member.displayName || '我', uin: '' });
    }
    return map;
  }, [personas.data, groupDetail.data]);
  const sessionTitle = target
    ? ((sessions.data ?? []).find((item) => generatedContentContainer(item) === key)?.title ?? '')
    : '';
  /** 克隆体 / 克隆群 / 助手的头像来源（会话列表项与消息气泡共用）。 */
  const avatarFor = (owner: Pick<GeneratedConversation, 'kind' | 'ownerId'>): AvatarInfo => {
    if (owner.kind === 'assistant') return {};
    if (owner.kind === 'group')
      return {
        groupUins: groupList.data?.find((group) => group.id === owner.ownerId)?.memberUins ?? [],
      };
    return { uin: members.get(owner.ownerId)?.uin || undefined };
  };
  /** 单条消息的发送者：群聊按 senderId，私聊只有我对 TA。 */
  const senderOf = (row: GeneratedRow): MemberInfo => {
    if (row.role === 'user' || row.senderKind === 'user') return ME;
    if (target?.kind === 'assistant') return { name: '助手', uin: '' };
    const bySender = row.senderId ? members.get(row.senderId) : undefined;
    if (bySender) return bySender;
    return { name: sessionTitle || '克隆体', uin: '' };
  };
  /**
   * 私聊克隆体的气泡头像：后端记录里没有 senderId 时，用当前会话对象的源好友 uin。
   * 之前这里只能拿到空 uin，QqAvatar 直接 falling back 成灰色小人。
   */
  const cloneUin = target ? avatarFor(target).uin : undefined;
  /** 群头像九宫格：复用会话列表那套合成逻辑（会话列表行直接用它）。 */
  const groupAvatarUins = target?.kind === 'group' ? (avatarFor(target).groupUins ?? []) : [];
  const supportsGroup = target?.kind === 'group';
  const groupMemberCount = target?.kind === 'group' ? groupAvatarUins.length : 0;
  const formatMulti = useMultiSelection({
    ids: FORMATS,
    selected: formats,
    onChange: setFormats,
    disabled: busy,
  });
  const visible = useMemo(
    () =>
      (sessions.data ?? []).filter((session) =>
        `${session.title} ${session.sessionTitle}`
          .toLocaleLowerCase()
          .includes(keyword.trim().toLocaleLowerCase()),
      ),
    [sessions.data, keyword],
  );
  const missing =
    !content.data || content.isFetching
      ? []
      : (ids?.filter((id) => !rows.some((row) => row.id === id)) ?? []);
  const canExport =
    !disabled &&
    ready &&
    target &&
    content.data &&
    !content.isFetching &&
    !content.isError &&
    !busy &&
    formats.size > 0 &&
    ids?.length !== 0 &&
    missing.length === 0;
  async function submit(intent?: ExportSavePolicy) {
    if (
      !target ||
      disabled ||
      !ready ||
      busy ||
      !formats.size ||
      ids?.length === 0 ||
      missing.length ||
      !content.data
    )
      return;
    const frozen = {
      ...binding,
      target: { ...target },
      messageIds: ids === undefined ? undefined : [...ids],
      formats: [...formats],
    };
    setBusy(true);
    setError('');
    try {
      const savePolicy = await prepareSave(intent, { kind: 'bundle', name: '生成对话' });
      if (!savePolicy || !isCurrent()) return;
      await client.account.startGeneratedExport.mutate({ ...frozen, savePolicy });
      if (isCurrent()) onStarted();
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="weq-generated-export" aria-label="本地生成对话导出">
      <div className="weq-generated-export-body">
        <div className="weq-generated-export-sessions">
          <label className="weq-message-scope-search">
            <Search size={15} />
            <input
              aria-label="查找生成对话"
              placeholder="查找对话"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
          {sessions.isError || account.isError ? (
            <div role="alert">
              对话列表读取失败
              <button
                type="button"
                title="重试读取生成对话"
                aria-label="重试读取生成对话"
                onClick={() => {
                  void account.refetch();
                  void sessions.refetch();
                }}
              >
                <RotateCw size={14} />
              </button>
            </div>
          ) : null}
          {sessions.isLoading && ready ? (
            <PickerListSkeleton rows={6} />
          ) : (
            <WindowedList
              items={visible}
              height={420}
              rowHeight={64}
              itemKey={generatedContentContainer}
              label="生成对话列表"
              scrollToKey={key}
              resetKey={keyword}
              renderItem={(session) => {
                const avatar = avatarFor(session);
                return (
                  <button
                    type="button"
                    className="weq-generated-export-row is-session"
                    disabled={busy}
                    aria-pressed={generatedContentContainer(session) === key}
                    onClick={() =>
                      setTarget({
                        kind: session.kind,
                        ownerId: session.ownerId,
                        sessionId: session.sessionId,
                      })
                    }
                  >
                    <span className="weq-generated-export-avatar" aria-hidden>
                      {session.kind === 'assistant' ? (
                        <span className="weq-generated-export-avatar-fb is-assistant">
                          <Sparkles size={16} strokeWidth={1.9} />
                        </span>
                      ) : session.kind === 'group' && (avatar.groupUins?.length ?? 0) > 0 ? (
                        // 克隆群：成员头像九宫格，与真实群会话列表口径一致。
                        <span className="weq-generated-export-avatar-grid">
                          {avatar.groupUins!.slice(0, 4).map((uin) => (
                            <QqAvatar key={uin} uin={uin} size={16} />
                          ))}
                        </span>
                      ) : (
                        <QqAvatar uin={avatar.uin || null} size={34} />
                      )}
                    </span>
                    <span className="weq-generated-export-session-text">
                      <strong>{session.title}</strong>
                      <span>
                        {session.sessionTitle} · {session.count} 条
                      </span>
                    </span>
                  </button>
                );
              }}
            />
          )}
          {!sessions.isLoading && !sessions.isError && !visible.length ? (
            <p>没有本地生成对话</p>
          ) : null}
        </div>
        <div className="weq-generated-export-messages" {...messageMulti.rootProps}>
          {!target ? (
            <p>请选择对话</p>
          ) : content.isError ? (
            <div role="alert">
              记录读取失败，原选择保留
              <button
                type="button"
                title="重试读取生成记录"
                aria-label="重试读取生成记录"
                onClick={() => void content.refetch()}
              >
                <RotateCw size={14} />
              </button>
            </div>
          ) : (
            <>
              <header className="weq-generated-export-range">
                <label className="weq-message-scope-mode">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={ids !== undefined}
                    onChange={(event) =>
                      setScopes((current) => {
                        const next = { ...current };
                        if (event.target.checked) next[key] = [];
                        else delete next[key];
                        return next;
                      })
                    }
                  />
                  <span>
                    {ids === undefined ? '整场持久对话' : `精确选中 ${ids.length} 条消息`}
                  </span>
                </label>
              </header>
              <div className="weq-generated-export-transcript">
                {content.isFetching && rows.length === 0 ? (
                  <PickerListSkeleton rows={5} />
                ) : rows.length === 0 ? (
                  <p className="weq-generated-export-empty">这段对话还没有消息。</p>
                ) : null}
                {rows.map((row, index) => {
                  const sender = senderOf(row);
                  const mine = row.role === 'user' || row.senderKind === 'user';
                  const prevTs = index > 0 ? rows[index - 1]?.ts : undefined;
                  const personaId =
                    row.role === 'assistant' && target.kind !== 'assistant'
                      ? (sender.personaId ??
                        (target.kind === 'persona' ? target.ownerId : undefined))
                      : undefined;
                  // 头像：群成员优先用 senderId 解析到的 uin，私聊克隆体回落到会话对象
                  // 自己的源好友 uin —— 不能被 QqAvatar 回落成灰色小人。
                  const rowUin = mine
                    ? selfProfile.data?.uin
                    : sender.uin || (target.kind === 'persona' ? cloneUin : undefined);
                  return (
                    <div
                      key={row.id}
                      {...messageMulti.itemProps(row.id)}
                      className={`weq-generated-message weq-generated-export-bubble${selected.has(row.id) ? ' is-selected' : ''}`}
                    >
                      {shouldShowChatTime(prevTs, row.ts) ? <ChatTimeDivider ts={row.ts} /> : null}
                      <ChatBubble
                        mine={mine}
                        bot={!mine && target.kind === 'assistant'}
                        name={mine ? selfProfile.data?.nick || '我' : sender.name}
                        uin={rowUin}
                        text={row.text}
                        personaId={personaId}
                      />
                    </div>
                  );
                })}
              </div>
              {/* 群聊成员数：合成头像本身在会话列表 / 头部展示，这里只补一句成员概览。 */}
              {supportsGroup ? (
                <p className="weq-generated-export-group-hint">
                  <Users size={12} aria-hidden />
                  {groupMemberCount} 位成员
                </p>
              ) : null}
              {missing.length ? (
                <p role="alert">
                  {missing.length} 条已选记录不存在或尚未持久化，请稍后重试或重新选择。
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <footer className="weq-generated-export-foot">
        <div role="group" aria-label="生成对话导出格式" {...formatMulti.rootProps}>
          {FORMATS.map((format) => (
            <label key={format} {...formatMulti.itemProps(format)}>
              <input type="checkbox" readOnly checked={formats.has(format)} disabled={busy} />
              {format.toUpperCase()}
            </label>
          ))}
        </div>
        <div className="weq-save-action-group">
          <button
            type="button"
            className="weq-exp-primary"
            disabled={!canExport}
            onClick={() => void submit()}
          >
            <Download size={15} />
            {busy ? '准备中…' : '导出生成对话'}
          </button>
          <ExportSaveActions disabled={!canExport} onSelect={(intent) => void submit(intent)} />
        </div>
      </footer>
    </section>
  );
}
