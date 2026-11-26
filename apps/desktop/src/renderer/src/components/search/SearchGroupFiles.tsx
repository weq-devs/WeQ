import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { filterByName } from '../../lib/nameSearch';
import { trpc } from '../../trpc/client';
import { SearchResultCard } from './SearchResultCard';

export type SearchFileGroup = { code: string; name: string };

export function SearchGroupFiles({
  group,
  onPick,
  onBack,
  children,
}: {
  group: SearchFileGroup | null;
  onPick: (group: SearchFileGroup) => void;
  onBack: () => void;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const directory = trpc.account.exportGroupDirectory.useQuery(undefined, {
    enabled: !group,
    refetchOnMount: 'always',
  });
  const back = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const selected = useRef<string | null>(null);
  useLayoutEffect(() => (group ? back.current : input.current)?.focus(), [group]);
  useLayoutEffect(() => {
    if (group || directory.isFetching || !selected.current) return;
    const row = options.current?.querySelector<HTMLButtonElement>(
      `[data-search-hit-key="group:${CSS.escape(selected.current)}"]`,
    );
    row?.focus();
    selected.current = null;
  }, [group, directory.isFetching]);
  const groups = useMemo(
    () =>
      filterByName(
        directory.data ?? [],
        query,
        (row) => [row.groupName],
        (row, needle) => `${row.groupName}\n${row.groupCode}`.toLocaleLowerCase().includes(needle),
      ),
    [directory.data, query],
  );

  return (
    <div className="weq-search-dropdown weq-search-detail">
      <header className="weq-search-more-head">
        <button
          ref={back}
          type="button"
          className="weq-search-more-back"
          data-search-back
          aria-label="返回"
          title="返回"
          onClick={onBack}
        >
          <ArrowLeft size={18} aria-hidden />
        </button>
        <h3 className="weq-search-more-title">{group?.name ?? '选择群聊'}</h3>
      </header>
      {group ? (
        <div className="weq-search-detail-body">{children}</div>
      ) : (
        <>
          <div className="weq-search-more-head">
            <input
              ref={input}
              type="search"
              value={query}
              data-search-row-input
              className="weq-set-input"
              aria-label="搜索群名或群号"
              placeholder="搜索群名或群号"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {directory.isFetching ? (
            <div className="weq-search-empty" role="status">
              正在加载
            </div>
          ) : directory.isError ? (
            <div className="weq-search-empty" role="status">
              群目录读取失败{' '}
              <button type="button" onClick={() => void directory.refetch()}>
                重试
              </button>
            </div>
          ) : groups.length ? (
            <div ref={options}>
              {groups.map((row) => (
                <SearchResultCard
                  key={row.groupCode}
                  keyword={query}
                  hit={{
                    category: 'group',
                    groupCode: row.groupCode,
                    name: row.groupName || row.groupCode,
                    remark: '',
                    inDirectory: true,
                    hasConversation: false,
                    aliases: [],
                  }}
                  keepOpen
                  onSelect={() => {
                    selected.current = row.groupCode;
                    onPick({ code: row.groupCode, name: row.groupName || row.groupCode });
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="weq-search-empty">没有匹配的群聊</div>
          )}
        </>
      )}
    </div>
  );
}
