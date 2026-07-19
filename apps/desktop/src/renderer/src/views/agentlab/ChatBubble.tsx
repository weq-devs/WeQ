/** 复用 im-template 的 QQ 气泡样式（chat.css 的 message-line / message-bubble）渲染一行。 */
import { Fragment, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Bot, Pause, Play } from 'lucide-react';
import { QqAvatar } from '../../components/QqAvatar';
import { FaceEmoji } from '../../components/FaceEmoji';

/** 系统表情匹配上下文：whitelist=本克隆体用过的 faceText；descToId=外显文字→faceId。 */
export interface FaceContext {
  whitelist: string[];
  descToId: Map<string, number>;
}

/** 归一化 faceText / 表情外显文字：去掉 /、[]、【】、空白后比对（"/捂脸"="[捂脸]"="捂脸"）。 */
export function normFaceKey(s: string): string {
  return s.replace(/[/[\]【】\s]/g, '').toLowerCase();
}

/** 由 getSystemFaces 结果构建 归一化外显文字 → faceId 的映射。 */
export function buildFaceMap(entries: ReadonlyArray<{ id: number; desc: string }>): Map<string, number> {
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
  const re = new RegExp(`(${tokens.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`, 'g');
  const parts = text.split(re);
  return parts.map((part, i) => {
    const id = faces.descToId.get(normFaceKey(part));
    if (id !== undefined && tokens.includes(part)) {
      // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
      return <FaceEmoji key={i} element={{ faceId: id, faceText: part }} size="1.3em" className="weq-inline-face" />;
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
  const src = `weq-media://agentvoice?persona=${encodeURIComponent(personaId)}&id=${encodeURIComponent(voiceId)}`;
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
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
          <span key={i} className={`weq-agentlab-voice-bar${playing ? ' is-playing' : ''}`} style={{ animationDelay: `${i * 0.12}s` }} />
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
}): ReactElement {
  // 自定义表情包：整条消息就是一个表情标记时，渲染成图片。
  const stickerMatch = personaId ? text.match(STICKER_MARKER) : null;
  // 合成语音：整条消息就是一个语音标记时，渲染成语音气泡。
  const voiceMatch = personaId ? text.match(VOICE_MARKER) : null;
  // 头像统一用 uin 拼 weq-avatar:// 协议，不依赖数据库里存的外链。
  const avatar = (
    <span className="avatar">
      <QqAvatar uin={uin} size={36} />
    </span>
  );
  return (
    <div className={`message-line ${mine ? 'mine' : 'theirs'}`}>
      {!mine ? avatar : null}
      <div className="message-bubble">
        {!mine ? (
          <span className="message-name">
            {name}
            {bot ? (
              <small className="bot-badge" aria-label="AI">
                <Bot size={12} strokeWidth={2.4} />
              </small>
            ) : null}
          </span>
        ) : null}
        <div className="message-content">
          {stickerMatch ? (
            <img
              className="weq-agentlab-sticker-img"
              src={`weq-media://sticker?persona=${encodeURIComponent(personaId!)}&md5=${encodeURIComponent(stickerMatch[1] ?? '')}`}
              alt="[表情]"
              draggable={false}
              onLoad={onMediaLoad}
            />
          ) : voiceMatch ? (
            <VoiceBubble personaId={personaId!} voiceId={voiceMatch[1] ?? ''} />
          ) : faces ? (
            renderWithFaces(text, faces)
          ) : (
            text
          )}
        </div>
      </div>
      {mine ? avatar : null}
    </div>
  );
}
