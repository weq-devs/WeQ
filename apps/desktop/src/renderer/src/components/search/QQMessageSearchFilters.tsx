import { X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { hasGlobalChatRecordFilter, type GlobalChatRecordFilter } from '@weq/service/search-policy';
import { beijingDay, daySeconds } from '../../lib/messageCalendar';
import { client } from '../../trpc/client';
import { CalendarDateField } from '../CalendarDateField';
import { FormSelect, FormSuggestions } from '../FormSelect';
import { MESSAGE_CATEGORY_LABELS } from './types';

type SenderOption = { value: string; label: string };
const isSenderId = (value: string) => /^(?:[1-9]\d*|u_[\w-]+)$/.test(value);

export function QQMessageSearchFilters({
  filter,
  senderLabel,
  onChange,
}: {
  filter: GlobalChatRecordFilter;
  senderLabel?: string;
  onChange: (state: { filter: GlobalChatRecordFilter; senderLabel?: string }) => void;
}) {
  const senderId = useId();
  const [senderQuery, setSenderQuery] = useState('');
  const [matches, setMatches] = useState<{ query: string; options: SenderOption[] }>();
  const query = senderQuery.trim();
  const start = filter.start === undefined ? '' : beijingDay(new Date(filter.start * 1000));
  const end = filter.end === undefined ? '' : beijingDay(new Date(filter.end * 1000));

  useEffect(() => {
    if (!query || filter.sender) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const { contacts } = await client.account.searchQuick.query(
          { keyword: query, categories: ['contact'], sources: ['qq'], limit: 12 },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const needle = query.toLocaleLowerCase();
        const options = new Map<string, SenderOption>();
        for (const contact of contacts ?? []) {
          const value = contact.uin || contact.uid;
          if (!isSenderId(value)) continue;
          const names = [contact.remark, contact.nick, ...contact.aliases];
          const matched = names.find((name) => name.toLocaleLowerCase().includes(needle));
          const label = matched || contact.remark || contact.nick || value;
          options.set(value, { value, label });
        }
        setMatches({ query, options: [...options.values()] });
      } catch {
        if (!controller.signal.aborted) setMatches({ query, options: [] });
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, filter.sender]);

  const options = matches?.query === query ? matches.options : [];
  const suggestions =
    isSenderId(query) && !options.some((person) => person.value === query)
      ? [...options, { value: query, label: '' }]
      : options;
  const update = (patch: GlobalChatRecordFilter) =>
    onChange({ filter: { ...filter, ...patch }, senderLabel });
  const clear = (nextFilter: GlobalChatRecordFilter) => {
    document.getElementById(senderId)?.focus({ preventScroll: true });
    setSenderQuery('');
    onChange({ filter: nextFilter });
  };

  return (
    <div className="weq-qq-message-filters" role="group" aria-label="QQ 消息筛选条件">
      <div className="weq-qq-message-filter-scope">
        <span>QQ 私聊与群聊</span>
        {hasGlobalChatRecordFilter(filter) ? (
          <button type="button" className="weq-search-more" onClick={() => clear({})}>
            清除条件
          </button>
        ) : null}
      </div>
      <div className="weq-qq-message-filter-fields">
        <div className="weq-qq-message-filter-field">
          <label htmlFor={senderId}>发送者</label>
          <div className="weq-qq-message-sender">
            <FormSuggestions
              id={senderId}
              aria-label="发送者"
              className="weq-set-input"
              placeholder="昵称、备注或 QQ 号"
              autoComplete="off"
              maxLength={128}
              readOnly={Boolean(filter.sender)}
              value={filter.sender ? senderLabel || filter.sender : senderQuery}
              options={filter.sender ? [] : suggestions}
              onValueChange={setSenderQuery}
              onSelectSuggestion={(sender) => {
                onChange({
                  filter: { ...filter, sender },
                  senderLabel: options.find((person) => person.value === sender)?.label,
                });
                setSenderQuery('');
              }}
            />
            {filter.sender ? (
              <button
                type="button"
                className="weq-search-more"
                aria-label="清除发送者"
                onClick={() => clear({ ...filter, sender: undefined })}
              >
                <X size={14} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
        <div className="weq-qq-message-filter-field">
          <span>消息类型</span>
          <FormSelect
            aria-label="消息类型"
            value={filter.category ?? ''}
            onChange={(event) =>
              update({
                category: (event.target.value || undefined) as GlobalChatRecordFilter['category'],
              })
            }
          >
            <option value="">全部消息</option>
            {Object.entries(MESSAGE_CATEGORY_LABELS).map(([category, label]) => (
              <option key={category} value={category}>
                {category === 'file' ? '文件消息' : label}
              </option>
            ))}
          </FormSelect>
        </div>
        <div className="weq-qq-message-filter-field">
          <span>起始日期</span>
          <CalendarDateField
            label="起始日期"
            value={start}
            max={end || undefined}
            onChange={(day) => update({ start: day ? Math.max(0, daySeconds(day)) : undefined })}
          />
        </div>
        <div className="weq-qq-message-filter-field">
          <span>截止日期</span>
          <CalendarDateField
            label="截止日期"
            value={end}
            min={start || undefined}
            onChange={(day) => update({ end: day ? daySeconds(day) + 86399 : undefined })}
          />
        </div>
      </div>
    </div>
  );
}
