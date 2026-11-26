import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPinyinMatcher } from '@weq/codec/pinyin-search';
import { Search, UsersRound, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { QqAvatar } from '../QqAvatar';
import { client } from '../../trpc/client';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { c2cAvatarSrc } from './SearchResultCard.shared';
import { CheckPill } from '../settings/controls';
import { useGroupMemberRosterOrder } from '../../lib/groupMemberRosterOrder';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { LoadingIndicator } from '../LoadingIndicator';

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
  const needle = query.trim().toLocaleLowerCase();
  const key = `${binding?.expectedAccountUin}:${binding?.expectedAccountConfigId ?? ''}`;
  const { order } = useGroupMemberRosterOrder(key, groupCode ?? '');
  const canReadRoster = Boolean(groupCode && binding);
  const roster = useQuery({
    ...PROFILE_QUERY_OPTIONS,
    queryKey: ['group-member-roster', key, groupCode, 'all', order],
    enabled: canReadRoster,
    queryFn: ({ signal }) =>
      client.account.groupMemberRoster.query(
        { ...binding!, groupCode: groupCode!, ...order, limit: 'all' },
        { signal },
      ),
    refetchInterval: (data) => (data?.preparing ? 500 : false),
  });
  const matches = useMemo(() => {
    const matches = new Map<string, RecordSender>();
    const pinyin = createPinyinMatcher(needle);
    for (const { member, displayName, remark, nick } of roster.data?.members ?? []) {
      if (
        !needle ||
        [displayName, remark, nick ?? member.nick, member.uin, member.uid].some((value) =>
          value?.toLocaleLowerCase().includes(needle),
        ) ||
        pinyin?.test(displayName, remark, nick ?? member.nick)
      )
        matches.set(member.uin, {
          id: member.uin,
          label: displayName,
          avatar: c2cAvatarSrc(member.uin),
        });
    }
    // 查找时仍可用已知的历史发送者或直接输入其号码。
    if (!groupCode || needle) {
      for (const option of [...options, ...selected]) {
        if (
          !matches.has(option.id) &&
          (!needle ||
            `${option.label} ${option.id}`.toLocaleLowerCase().includes(needle) ||
            pinyin?.test(option.label))
        )
          matches.set(option.id, option);
      }
    }
    if (groupCode && /^(?:[1-9]\d*|u_[\w-]+)$/.test(needle) && !matches.has(needle))
      matches.set(needle, {
        id: needle,
        label: needle,
        avatar: /^\d+$/.test(needle) ? c2cAvatarSrc(needle) : null,
      });
    return [...matches.values()];
  }, [groupCode, needle, options, roster.data, selected]);
  const activeIds = new Set(selected.map(({ id }) => id));
  const loadingRoster = canReadRoster && roster.isInitialLoading;
  const rosterError = roster.error instanceof Error ? roster.error.message : '';
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
        <header>
          <h3 id="record-senders-title">发送者</h3>
          <button type="button" className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="weq-record-search-input">
          <Search size={16} aria-hidden />
          <input
            type="search"
            aria-label="查找发送者"
            placeholder="昵称、备注或 QQ 号"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-weq-autofocus
          />
          {query ? (
            <button
              type="button"
              className="weq-dialog-x"
              aria-label="清空查找"
              onClick={() => setQuery('')}
            >
              <X size={15} aria-hidden />
            </button>
          ) : null}
        </div>
        <CheckPill checked={!selected.length} onChange={() => onChange([])}>
          <span className="weq-record-sender-placeholder">
            <RecordSenderAvatar />
          </span>
          <span>全部发送者</span>
        </CheckPill>
        <div className="weq-record-sender-options">
          {matches.map((sender) => (
            <CheckPill
              key={sender.id}
              checked={activeIds.has(sender.id)}
              onChange={(checked) =>
                onChange(
                  checked ? [...selected, sender] : selected.filter(({ id }) => id !== sender.id),
                )
              }
            >
              <RecordSenderAvatar sender={sender} />
              <span data-privacy-sensitive title={sender.label}>
                {sender.label}
              </span>
            </CheckPill>
          ))}
          {loadingRoster ? (
            <p className="weq-record-sender-feedback" role="status">
              <LoadingIndicator>正在读取群成员…</LoadingIndicator>
            </p>
          ) : !matches.length && !rosterError && (needle || roster.isSuccess) ? (
            <p className="weq-record-sender-feedback" role="status">
              {needle ? '未找到发送者' : '暂无本地群成员记录'}
            </p>
          ) : null}
        </div>
        {rosterError ? (
          <p className="weq-record-sender-feedback" role="alert">
            {rosterError}{' '}
            <button type="button" className="weq-set-btn" onClick={() => void roster.refetch()}>
              重试
            </button>
          </p>
        ) : groupCode && !canReadRoster ? (
          <p className="weq-record-sender-feedback" role="status">
            暂时无法读取群成员
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
