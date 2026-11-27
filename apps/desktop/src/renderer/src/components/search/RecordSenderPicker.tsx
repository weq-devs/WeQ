import { useEffect, useMemo, useState } from 'react';
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
import '../../styles/chat-records.css';

export type RecordSender = {
  id: string;
  label: string;
  avatar?: string | null;
  historicalId?: string;
};

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
  const needle = query.trim().slice(0, 128).toLocaleLowerCase();
  const [historyKeyword, setHistoryKeyword] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setHistoryKeyword(needle), 200);
    return () => clearTimeout(timer);
  }, [needle]);
  const historyEnabled = Boolean(
    binding && groupCode && historyKeyword && needle === historyKeyword,
  );
  const history = useQuery<Awaited<ReturnType<typeof client.account.groupSenderNames.query>>>({
    ...PROFILE_QUERY_OPTIONS,
    queryKey: ['group-history-sender-search', binding, groupCode, historyKeyword],
    enabled: historyEnabled,
    refetchInterval: (data) => (data?.indexPending ? 1500 : false),
    queryFn: ({ signal }) =>
      client.account.groupSenderNames.query(
        { ...binding!, groupCode, keyword: historyKeyword },
        { signal },
      ),
  });

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
    for (const row of historyEnabled ? (history.data?.rows ?? []) : []) {
      const uin = /^[1-9]\d*$/.test(row.senderUin) ? row.senderUin : '';
      const id = uin || row.senderUid;
      matches.set(id, {
        id,
        label: row.name,
        historicalId: uin,
        avatar: uin ? c2cAvatarSrc(uin) : null,
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
  }, [groupCode, needle, options, roster.data, selected, history.data, historyEnabled]);
  const activeIds = new Set(selected.map(({ id }) => id));
  const loadingRoster = canReadRoster && roster.isInitialLoading;
  const loadingHistory = Boolean(
    groupCode &&
      binding &&
      needle &&
      (!historyEnabled || history.isInitialLoading || history.data?.indexPending),
  );
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
            placeholder={groupCode ? '昵称、历史称呼或 QQ 号' : '昵称、备注或 QQ 号'}
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
              <span className="weq-record-sender-name" data-privacy-sensitive title={sender.label}>
                {sender.label}
              </span>
              {sender.historicalId && sender.historicalId !== sender.label ? (
                <span
                  className="weq-record-sender-history-id weq-number weq-number-inherit"
                  data-privacy-sensitive
                >
                  {sender.historicalId}
                </span>
              ) : null}
            </CheckPill>
          ))}
          {loadingRoster || loadingHistory ? (
            <p className="weq-record-sender-feedback" role="status">
              <LoadingIndicator>
                {loadingRoster ? '正在读取群成员…' : '正在查找历史称呼…'}
              </LoadingIndicator>
            </p>
          ) : !matches.length && !rosterError && (needle || roster.isSuccess) ? (
            <p className="weq-record-sender-feedback" role="status">
              {needle ? '未找到发送者' : '暂无本地群成员记录'}
            </p>
          ) : null}
        </div>
        {historyEnabled && history.isError ? (
          <p className="weq-record-sender-feedback" role="alert">
            历史称呼读取失败
            <button type="button" className="weq-set-btn" onClick={() => void history.refetch()}>
              重试
            </button>
          </p>
        ) : null}
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
