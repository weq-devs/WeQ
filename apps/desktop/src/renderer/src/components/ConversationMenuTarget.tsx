import { useEffect, useState } from 'react';
import { Avatar } from '../im-template/template/primitives';
import { copyTextToClipboard } from '../im-template/template/clipboard';
import { useRenderDocument } from '../lib/renderDocument';

/** 主列表和群助手共用右键对象与号码复制反馈。 */
export function ConversationMenuTarget({
  name,
  avatarUrl,
  identity,
  kind,
  count,
}: {
  name: string;
  avatarUrl?: string | null;
  identity: string;
  kind: 'direct' | 'group' | 'merged';
  count: number;
}) {
  const document = useRenderDocument();
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    setCopied(0);
  }, [identity]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const numberLabel = kind === 'group' ? '群号' : /^\d+$/.test(identity) ? 'QQ 号' : 'ID';
  return (
    <>
      <Avatar resolution="small" name={name} avatarUrl={avatarUrl} seed={identity} />
      <span>
        <strong title={name}>{count > 1 ? `已选 ${count} 个会话` : name}</strong>
        <small>
          {count > 1 ? (
            `从 ${name} 打开`
          ) : kind === 'merged' ? (
            '聚合会话'
          ) : (
            <>
              {kind === 'group' ? '群聊' : '私聊'} ·{' '}
              <button
                type="button"
                role="menuitem"
                className="weq-conversation-copy-number"
                title={`复制${numberLabel}`}
                aria-label={`复制${numberLabel}`}
                onClick={(event) => {
                  const button = event.currentTarget;
                  void copyTextToClipboard(identity, document).then((ok) => {
                    if (ok && button.isConnected) {
                      setCopied((value) => value + 1);
                      button.focus();
                    }
                  });
                }}
              >
                {identity}
                {copied ? (
                  <span key={copied} role="status" className="weq-conversation-copy-feedback">
                    已复制
                  </span>
                ) : null}
              </button>
            </>
          )}
        </small>
      </span>
    </>
  );
}
