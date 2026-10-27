/** 复用 im-template 的 QQ 气泡样式（chat.css 的 message-line / message-bubble）渲染一行。 */
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Bot, CheckSquare, Copy, Pause, Play, Sparkles } from 'lucide-react';
import { QqAvatar, qqAvatarUrl } from '../../components/QqAvatar';
import { MessageBubble } from '../../im-template/template/messageBubble';
import type { DirectConversation, Message, User } from '../../im-template/template/types';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import { useToast } from '../../components/Toast';
import { VirtualConversationBadge } from '../../components/VirtualConversationAvatar';
import { FaceEmoji } from '../../components/FaceEmoji';
import { mediaUrl } from '../../lib/resourceUrl';

/** 系统表情匹配上下文：whitelist=本克隆体用过的 faceText；descToId=外显文字→faceId。 */
export interface FaceContext {
  whitelist: string[];
  descToId: Map<string, number>;
}

/** 输入工具栏插入的 /表情名使用完整系统表情表，不受克隆体训练白名单限制。 */
export function inputFaceContext(descToId: Map<string, number>): FaceContext {
  return { whitelist: [...descToId.keys()].map((name) => `/${name}`), descToId };
}

/** 归一化 faceText / 表情外显文字：去掉 /、[]、【】、空白后比对（"/捂脸"="[捂脸]"="捂脸"）。 */
export function normFaceKey(s: string): string {
  return s.replace(/[/[\]【】\s]/g, '').toLowerCase();
}

/** 由 getSystemFaces 结果构建 归一化外显文字 → faceId 的映射。 */
export function buildFaceMap(
  entries: ReadonlyArray<{ id: number; desc: string }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    const key = normFaceKey(e.desc);
    if (key && !map.has(key)) map.set(key, e.id);
  }
  return map;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把文本里的系统表情 faceText（来自 whitelist）替换成渲染好的表情图，其余原样。 */
function renderWithFaces(text: string, faces: FaceContext): ReactNode {
  const tokens = faces.whitelist.filter(Boolean);
  if (tokens.length === 0) return text;
  const re = new RegExp(
    `(${tokens
      .slice()
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|')})`,
    'g',
  );
  const parts = text.split(re);
  return parts.map((part, i) => {
    const id = faces.descToId.get(normFaceKey(part));
    if (id !== undefined && tokens.includes(part)) {
      return (
        <FaceEmoji
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
          key={i}
          element={{ faceId: id, faceText: part }}
          size="1.3em"
          className="weq-inline-face"
        />
      );
    }
    // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** 自定义表情包标记：[[sticker:<md5>]]，由后端落库 / 前端实时插入。 */
const STICKER_MARKER = /^\[\[sticker:([0-9a-fA-F]+)\]\]$/;
/** 克隆体合成语音标记：[[voice:<hash.ext>]]，由后端落库 / 前端实时插入。 */
const VOICE_MARKER = /^\[\[voice:([0-9a-zA-Z._-]+)\]\]$/;

/** 克隆体语音气泡：点击播放后端合成的语音（weq-media://agentvoice）。 */
function VoiceBubble({ personaId, voiceId }: { personaId: string; voiceId: string }): ReactElement {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const src = mediaUrl('agentvoice', { persona: personaId, id: voiceId });
  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    [],
  );
  const toggle = (): void => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(src);
      audio.onended = () => setPlaying(false);
      audio.onpause = () => setPlaying(false);
      audio.onplay = () => setPlaying(true);
      audioRef.current = audio;
    }
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  };
  return (
    <button type="button" className="weq-agentlab-voice" onClick={toggle} aria-label="播放语音">
      {playing ? <Pause size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
      <span className="weq-agentlab-voice-bars" aria-hidden>
        {Array.from({ length: 6 }).map((_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            key={i}
            className={`weq-agentlab-voice-bar${playing ? ' is-playing' : ''}`}
            style={{ animationDelay: `${i * 0.12}s` }}
          />
        ))}
      </span>
      <span className="weq-agentlab-voice-label">语音</span>
    </button>
  );
}

export function ChatBubble({
  mine,
  name,
  uin,
  text,
  bot,
  faces,
  personaId,
  onMediaLoad,
  conversationStyle = false,
  showSenderName = false,
  onSelect,
  messageId,
  selectionMode,
  selected,
}: {
  mine: boolean;
  name: string;
  uin?: string;
  text: string;
  bot?: boolean;
  /** 提供后，会把文本里的系统表情 faceText 渲染成表情图（克隆体气泡用）。 */
  faces?: FaceContext;
  /** 克隆体 id：提供后，[[sticker:md5]] 标记会渲染成自定义表情图。 */
  personaId?: string;
  /** 图片类消息加载后通知父级重新贴底。 */
  onMediaLoad?: () => void;
  /** 克隆聊天使用普通会话完整气泡；助手与导出预览保留原呈现。 */
  conversationStyle?: boolean;
  showSenderName?: boolean;
  onSelect?: () => void;
  messageId?: string;
  selectionMode?: boolean;
  selected?: boolean;
}): ReactElement {
  const localId = useId();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 自定义表情包：整条消息就是一个表情标记时，渲染成图片。
  const stickerMatch = personaId ? text.match(STICKER_MARKER) : null;
  // 表情图加载失败（资源被清 / 下载失败）时降级为文字占位，别留个破图。
  const [stickerFailed, setStickerFailed] = useState(false);
  // 合成语音：整条消息就是一个语音标记时，渲染成语音气泡。
  const voiceMatch = personaId ? text.match(VOICE_MARKER) : null;
  const content = (
    <div className="message-content">
      {stickerMatch && !stickerFailed ? (
        <img
          className="weq-agentlab-sticker-img"
          src={mediaUrl('sticker', { persona: personaId!, md5: stickerMatch[1] ?? '' })}
          alt="[表情]"
          draggable={false}
          onLoad={onMediaLoad}
          onError={() => setStickerFailed(true)}
        />
      ) : stickerMatch ? (
        <span className="weq-agentlab-sticker-fallback">[表情]</span>
      ) : voiceMatch ? (
        <VoiceBubble personaId={personaId!} voiceId={voiceMatch[1] ?? ''} />
      ) : (
        <span data-privacy-sensitive>{faces ? renderWithFaces(text, faces) : text}</span>
      )}
    </div>
  );
  if (conversationStyle) {
    // 仅供呈现，不把本地克隆身份或合成序号交给 QQ 消息接口。
    const sender: User = {
      id: `clone:${personaId ?? 'self'}:${mine ? 'self' : 'peer'}`,
      identityLabel: '',
      identityValue: uin ?? localId,
      username: name,
      displayName: name,
      avatarUrl: uin ? qqAvatarUrl(uin) : null,
    };
    const conversation: DirectConversation = {
      id: `clone:${personaId ?? 'self'}`,
      type: 'direct',
      updatedAt: '',
      lastMessage: null,
      otherUser: sender,
      group: null,
      members: [],
    };
    const message: Message = {
      id: messageId ?? localId,
      conversationId: conversation.id,
      senderId: sender.id,
      body: text,
      createdAt: '',
    };
    return (
      <>
        <MessageBubble
          message={message}
          conversation={conversation}
          sender={sender}
          mine={mine}
          senderName={name}
          senderAvatarUrl={sender.avatarUrl}
          senderSeed={sender.identityValue}
          showSenderName={showSenderName}
          active={Boolean(menu)}
          selectionMode={selectionMode}
          selected={selected}
          avatarBadge={!mine ? <VirtualConversationBadge /> : undefined}
          renderers={[{ id: 'clone-content', match: () => true, render: () => content }]}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          onLongPress={setMenu}
        />
        {menu ? (
          <ConversationActionsMenu
            {...menu}
            label="消息操作"
            onClose={() => setMenu(null)}
            actions={[
              {
                label: '复制',
                icon: <Copy size={16} />,
                action: () => {
                  void copyTextToClipboard(text).then((ok) => {
                    if (!ok) useToast.getState().push({ tone: 'error', title: '复制失败' });
                  });
                },
              },
              ...(onSelect
                ? [{ label: '多选', icon: <CheckSquare size={16} />, action: onSelect }]
                : []),
            ]}
          />
        ) : null}
      </>
    );
  }
  // 头像统一用 uin 拼 weq-avatar:// 协议，不依赖数据库里存的外链。
  // 助手没有 QQ 号，用和助手面板一致的渐变星芒头像；给空 uin 只会回落成灰色小人。
  const avatar = (
    <span className="avatar">
      {bot && !uin ? (
        <span className="weq-asst-avatar is-bubble" aria-hidden>
          <Sparkles size={18} strokeWidth={1.9} />
        </span>
      ) : (
        <QqAvatar uin={uin} size={36} />
      )}
    </span>
  );
  return (
    <div className={`message-line ${mine ? 'mine' : 'theirs'}`}>
      {!mine ? avatar : null}
      <div className="message-bubble">
        {!mine ? (
          <span className="message-name">
            <span data-privacy-sensitive>{name}</span>
            {bot ? (
              <small className="bot-badge" aria-label="AI">
                <Bot size={12} strokeWidth={2.4} />
              </small>
            ) : null}
          </span>
        ) : null}
        {content}
      </div>
      {mine ? avatar : null}
    </div>
  );
}
