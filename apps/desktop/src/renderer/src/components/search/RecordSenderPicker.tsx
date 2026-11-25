import { useEffect, useState } from 'react';
import { UsersRound } from 'lucide-react';
import { Modal } from '../Dialog';
import { QqAvatar } from '../QqAvatar';
import { client } from '../../trpc/client';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { c2cAvatarSrc } from './SearchResultCard.shared';

export type RecordSender = { id: string; label: string; avatar?: string | null };

export function RecordSenderAvatar({ sender }: { sender?: RecordSender }) {
  return sender ? (
    <QqAvatar url={sender.avatar} size={24} className="weq-record-sender-avatar" />
  ) : (
    <UsersRound size={17} aria-hidden />
  );
}

export function RecordSenderPicker({
  options,
  selected,
  groupCode,
  binding,
  anchor,
  onChange,
  onClose,
}: {
  options: RecordSender[];
  selected: RecordSender[];
  groupCode?: string;
  binding?: QQWriteBinding;
  anchor: HTMLElement | null;
  onChange: (senders: RecordSender[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<{ query: string; items: RecordSender[]; error?: string }>();
  const needle = query.trim().toLocaleLowerCase();
  const expectedAccountUin = binding?.expectedAccountUin;
  const expectedAccountConfigId = binding?.expectedAccountConfigId;
  useEffect(() => {
    if (!groupCode || !needle) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void client.account.searchGroupMembers
        .query(
          {
            groupCode,
            keyword: needle,
            limit: 50,
            expectedAccountUin,
            expectedAccountConfigId,
          },
          { signal: controller.signal },
        )
        .then(({ members }) => {
          if (controller.signal.aborted) return;
          setRemote({
            query: needle,
            items: members.flatMap((member) => {
              const uin = member.uin && member.uin !== '0' ? member.uin : '';
              const id = uin || member.uid;
              return id
                ? [
                    {
                      id,
                      label: member.card || member.nick || id,
                      avatar: uin ? c2cAvatarSrc(uin) : null,
                    },
                  ]
                : [];
            }),
          });
        })
        .catch((failure) => {
          if (!controller.signal.aborted)
            setRemote({ query: needle, items: [], error: String(failure) });
        });
    }, 170);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [groupCode, needle, expectedAccountUin, expectedAccountConfigId]);

  const matches = new Map<string, RecordSender>();
  for (const option of [...selected, ...options]) {
    if (!needle || `${option.label} ${option.id}`.toLocaleLowerCase().includes(needle))
      matches.set(option.id, option);
  }
  if (remote?.query === needle)
    for (const option of remote.items) if (!matches.has(option.id)) matches.set(option.id, option);
  if (groupCode && /^(?:[1-9]\d*|u_[\w-]+)$/.test(needle) && !matches.has(needle))
    matches.set(needle, {
      id: needle,
      label: needle,
      avatar: /^\d+$/.test(needle) ? c2cAvatarSrc(needle) : null,
    });
  const activeIds = new Set(selected.map(({ id }) => id));
  return (
    <Modal
      presentation="popover"
      anchor={anchor}
      anchorPlacement="below"
      width={310}
      onClose={onClose}
      labelledBy="record-senders-title"
    >
      <div className="weq-record-sender-picker">
        <h3 id="record-senders-title">发送者</h3>
        <input
          aria-label="查找发送者"
          placeholder="昵称、备注或 QQ 号"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <button
          type="button"
          className="weq-record-sender-option"
          aria-pressed={!selected.length}
          onClick={() => onChange([])}
        >
          <RecordSenderAvatar /> 全部发送者
        </button>
        <div className="weq-record-sender-options">
          {[...matches.values()].map((sender) => (
            <label key={sender.id} className="weq-record-sender-option">
              <RecordSenderAvatar sender={sender} />
              <span data-privacy-sensitive>{sender.label}</span>
              <input
                type="checkbox"
                checked={activeIds.has(sender.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, sender]
                      : selected.filter(({ id }) => id !== sender.id),
                  )
                }
              />
            </label>
          ))}
        </div>
        {remote?.query === needle && remote.error ? <p role="alert">{remote.error}</p> : null}
      </div>
    </Modal>
  );
}
