import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { NumericText } from './NumericText';
import { Avatar } from '../im-template/template/primitives';
import { CopyButton } from './CopyButton';
import type { Conversation } from '../im-template/template/types';

/** 主列表和群助手共用右键对象与号码复制反馈。 */
export function ConversationMenuTarget({
  name,
  avatar,
  avatarUrl,
  identity,
  kind,
  generated,
  count,
  containedCount,
  onOpenProfile,
}: {
  name: string;
  avatar?: ReactNode;
  avatarUrl?: string | null;
  identity: string;
  kind: 'direct' | 'group' | 'merged';
  generated?: Conversation['generated'];
  count: number;
  containedCount?: number;
  onOpenProfile?: (anchor: HTMLElement) => void;
}) {
  const numberLabel = kind === 'group' ? '群号' : /^\d+$/.test(identity) ? 'QQ 号' : 'ID';
  const heading = (
    <>
      {avatar ??
        (generated?.kind === 'assistant' ? (
          <span className="avatar has-default merged-avatar" aria-hidden>
            <Sparkles size={16} />
          </span>
        ) : avatarUrl || onOpenProfile ? (
          <Avatar resolution="small" name={name} avatarUrl={avatarUrl} seed={identity} />
        ) : null)}
      <strong title={name}>
        {count > 1 ? <NumericText>{`已选 ${count} 个会话`}</NumericText> : name}
      </strong>
    </>
  );
  return (
    <>
      {onOpenProfile ? (
        <button
          type="button"
          role="menuitem"
          aria-haspopup="dialog"
          aria-label={`查看${name}的名片`}
          title="查看名片"
          className="weq-conversation-menu-identity"
          onClick={(event) => onOpenProfile(event.currentTarget)}
        >
          {heading}
        </button>
      ) : (
        <span className="weq-conversation-menu-identity">{heading}</span>
      )}
      <small>
        {count > 1 ? (
          `从 ${name} 打开`
        ) : generated ? (
          generated.kind === 'assistant' ? (
            'WeQ 助手会话'
          ) : generated.kind === 'group' ? (
            '克隆群聊'
          ) : (
            '克隆会话'
          )
        ) : kind === 'merged' ? (
          containedCount === undefined ? (
            '聚合会话'
          ) : (
            `内含 ${containedCount} 个群`
          )
        ) : (
          <>
            {kind === 'group' ? '群聊' : '私聊'} ·{' '}
            <CopyButton
              text={identity}
              role="menuitem"
              className="weq-conversation-copy-number"
              title={`复制${numberLabel}`}
              aria-label={`复制${numberLabel}`}
            >
              {identity}
            </CopyButton>
          </>
        )}
      </small>
    </>
  );
}
