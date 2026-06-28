/** 复用 im-template 的 QQ 气泡样式（chat.css 的 message-line / message-bubble）渲染一行。 */
import { type ReactElement } from 'react';
import { Bot } from 'lucide-react';
import { QqAvatar } from '../../components/QqAvatar';

export function ChatBubble({
  mine,
  name,
  uin,
  text,
  bot,
}: {
  mine: boolean;
  name: string;
  uin?: string;
  text: string;
  bot?: boolean;
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
        <div className="message-content">{text}</div>
      </div>
      {mine ? avatar : null}
    </div>
  );
}
