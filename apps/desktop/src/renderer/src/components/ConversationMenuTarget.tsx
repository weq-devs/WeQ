import { NumericText } from './NumericText';
import { Avatar } from '../im-template/template/primitives';
import { CopyButton } from './CopyButton';
import type { Conversation } from '../im-template/template/types';

/** 主列表和群助手共用右键对象与号码复制反馈。 */
export function ConversationMenuTarget({
  name,
  avatarUrl,
  identity,
  kind,
  generated,
  count,
  containedCount,
}: {
  name: string;
  avatarUrl?: string | null;
  identity: string;
  kind: 'direct' | 'group' | 'merged';
  generated?: Conversation['generated'];
  count: number;
  containedCount?: number;
}) {
  const numberLabel = kind === 'group' ? '群号' : /^\d+$/.test(identity) ? 'QQ 号' : 'ID';
  return (
    <>
      {avatarUrl ? (
        <Avatar resolution="small" name={name} avatarUrl={avatarUrl} seed={identity} />
      ) : null}
      <span>
        <strong title={name}>
          {count > 1 ? <NumericText>{`已选 ${count} 个会话`}</NumericText> : name}
        </strong>
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
      </span>
    </>
  );
}
