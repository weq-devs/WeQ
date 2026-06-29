/** 复用 im-template 的 QQ 气泡样式（chat.css 的 message-line / message-bubble）渲染一行。 */
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { Bot } from 'lucide-react';
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
      return <FaceEmoji key={i} element={{ faceId: id, faceText: part }} size="1.3em" className="weq-inline-face" />;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function ChatBubble({
  mine,
  name,
  uin,
  text,
  bot,
  faces,
}: {
  mine: boolean;
  name: string;
  uin?: string;
  text: string;
  bot?: boolean;
  /** 提供后，会把文本里的系统表情 faceText 渲染成表情图（克隆体气泡用）。 */
  faces?: FaceContext;
}): ReactElement {
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
        <div className="message-content">{faces ? renderWithFaces(text, faces) : text}</div>
      </div>
      {mine ? avatar : null}
    </div>
  );
}
