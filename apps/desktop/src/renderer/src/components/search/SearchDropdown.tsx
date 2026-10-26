/** The unified search dropdown under the sidebar search box. */

import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  Bookmark,
  Bot,
  File,
  FolderOpen,
  Globe,
  Hash,
  Images,
  Layers,
  Mail,
  MessageSquare,
  MessagesSquare,
  RotateCw,
  Settings2,
  Smile,
  UserRound,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import '../../styles/search-scope.css';
import { SearchResultCard } from './SearchResultCard';
import { SearchSectionSkeleton } from './SearchSkeleton';
import {
  isQzoneSearchCategory,
  qzoneSearchCoverage,
  rankContentSearchHits,
  rankFileSearchHits,
} from '@weq/service/search-policy';
import { AppSearchResults } from './AppSearchResults';
import { appSearchEntryRank, searchAppEntries, type AppSearchEntry } from './appSearchCatalog';
import { restoreSearchPosition, type SearchPosition } from './searchPosition';
import {
  CATEGORY_META,
  CONTENT_CATEGORY_ORDER,
  isContentSearchCategory,
  contentCoverageText,
  SEARCH_CATEGORY_ORDER,
  searchHitKey,
  searchHitNameRank,
  isSlowSearchCategory,
  type SearchCategory,
  type SearchHit,
  type QuickSearchResult,
  type SlowSearchResult,
  type SearchCategoryStates,
} from './types';

const scopeIcons: Record<SearchCategory, LucideIcon> = {
  contact: UserRound,
  group: UsersRound,
  conversation: MessagesSquare,
  friend: UserRound,
  groupMember: UsersRound,
  chatRecord: MessageSquare,
  file: File,
  qzone: Globe,
  collection: Bookmark,
  qzonePost: Globe,
  qzoneAlbum: Globe,
  otherQzonePost: Globe,
  otherQzoneAlbum: Globe,
  groupAlbum: Images,
  groupFile: FolderOpen,
  mailMessage: Mail,
  guildMessage: Hash,
  cloneMessage: MessagesSquare,
  assistantMessage: Bot,
  marketEmoji: Smile,
};

const scopeOptions = SEARCH_CATEGORY_ORDER.map((category) => ({
  id: category,
  Icon: scopeIcons[category],
  label: CATEGORY_META[category].label,
  categories: [category],
}));

export function SearchDropdown({
  keyword,
  quick,
  quickLoading,
  slow,
  slowLoading,
  categories,
  onCategoriesChange,
  quickError = false,
  slowError = false,
  onRetry,
  onSelect,
  onMore,
  initialPosition,
  onNavigate,
  appSearchEnabled = false,
  onAppSearchEnabledChange,
  onSelectAppEntry,
  categoryStates,
}: {
  keyword: string;
  quick: QuickSearchResult | null;
  quickLoading: boolean;
  slow: SlowSearchResult | null;
  slowLoading: boolean;
  categories: readonly SearchCategory[];
  onCategoriesChange: (categories: SearchCategory[]) => void;
  quickError?: boolean;
  slowError?: boolean;
  onRetry?: () => void;
  onSelect: (hit: SearchHit) => void;
  onMore: (category: SearchCategory) => void;
  initialPosition?: SearchPosition;
  onNavigate?: (position: SearchPosition) => void;
  appSearchEnabled?: boolean;
  onAppSearchEnabledChange?: (enabled: boolean) => void;
  onSelectAppEntry?: (entry: AppSearchEntry) => void;
  categoryStates?: SearchCategoryStates;
}): ReactElement {
  const hasKeyword = keyword.trim().length > 0;
  const allSelected =
    SEARCH_CATEGORY_ORDER.every((category) => categories.includes(category)) &&
    (!onSelectAppEntry || appSearchEnabled);
  const partiallySelected = categories.length > 0 || appSearchEnabled;
  const root = useRef<HTMLDivElement | null>(null);
  const position = useRef(initialPosition);
  const [expandedAppKeyword, setExpandedAppKeyword] = useState(
    initialPosition?.appResultsExpanded ? keyword : null,
  );
  const appResultsExpanded = expandedAppKeyword === keyword;
  const appEntries = useMemo(
    () => (appSearchEnabled ? searchAppEntries(keyword) : []),
    [keyword, appSearchEnabled],
  );
  const rememberPosition = (focusKey: string) =>
    onNavigate?.({
      scrollTop: root.current?.scrollTop ?? 0,
      focusKey,
      ...(appResultsExpanded ? { appResultsExpanded: true } : {}),
    });
  const attachRoot = useCallback((node: HTMLDivElement | null) => {
    root.current = node;
    if (node && position.current) {
      restoreSearchPosition(node, position.current);
      position.current = undefined;
    }
  }, []);
  // Map category → hits (or null while loading).
  const sections = new Map<SearchCategory, { hits: SearchHit[] | null; loading: boolean }>();
  sections.set('contact', {
    hits: quick ? (quick.contacts ?? []) : null,
    loading: quickLoading && !quick,
  });
  sections.set('group', {
    hits: quick ? (quick.groups ?? []) : null,
    loading: quickLoading && !quick,
  });
  sections.set('conversation', {
    hits: quick ? quick.conversations : null,
    loading: quickLoading && !quick,
  });
  sections.set('friend', { hits: quick ? quick.friends : null, loading: quickLoading && !quick });
  sections.set('groupMember', {
    hits: quick ? quick.groupMembers : null,
    loading: quickLoading && !quick,
  });
  sections.set('chatRecord', {
    hits: slow ? (slow.messageHits ?? slow.chatRecords) : null,
    loading: slowLoading && !slow,
  });
  sections.set('file', {
    hits: slow
      ? rankFileSearchHits(keyword, [
          ...slow.files,
          ...(slow.contentHits ?? []).filter((hit) => hit.category === 'groupFile'),
        ]).slice(0, 3)
      : null,
    loading: slowLoading && !slow,
  });
  sections.set('collection', {
    hits: slow ? slow.collections : null,
    loading: slowLoading && !slow,
  });
  sections.set('cloneMessage', {
    hits: slow ? slow.cloneMessages : null,
    loading: slowLoading && !slow,
  });
  sections.set('assistantMessage', {
    hits: slow ? slow.assistantMessages : null,
    loading: slowLoading && !slow,
  });
  for (const category of CONTENT_CATEGORY_ORDER)
    sections.set(category, {
      hits: slow ? (slow.contentHits ?? []).filter((hit) => hit.category === category) : null,
      loading: slowLoading && !slow,
    });
  sections.set('qzone', {
    hits: slow
      ? rankContentSearchHits(
          keyword,
          (slow.contentHits ?? []).filter((hit) => isQzoneSearchCategory(hit.category)),
        ).slice(0, 3)
      : null,
    loading: slowLoading && !slow,
  });
  for (const [category, section] of sections) {
    const status = categoryStates?.[category];
    if (status) section.loading = status.loading;
  }

  const indexBuilding =
    categories.some((c) => c === 'chatRecord' || c === 'file') &&
    !slowLoading &&
    slow?.indexStatus === 'building';
  const scopeSelection = useMultiSelection({
    ids: scopeOptions.map((option) => option.id),
    selected: new Set(
      scopeOptions
        .filter((option) => option.categories.every((category) => categories.includes(category)))
        .map((option) => option.id),
    ),
    onChange: (next) =>
      onCategoriesChange(
        scopeOptions.filter((option) => next.has(option.id)).flatMap((option) => option.categories),
      ),
  });
  const failedFor = (category: SearchCategory) =>
    isSlowSearchCategory(category)
      ? (categoryStates?.[category]?.error ?? slowError) ||
        Boolean(slow?.failedCategories?.includes(category)) ||
        (category === 'chatRecord' &&
          Boolean(
            slow?.failedCategories?.some(
              (source) => source === 'guildMessage' || source === 'cloneMessage',
            ),
          )) ||
        (category === 'file' && Boolean(slow?.failedCategories?.includes('groupFile'))) ||
        (category === 'qzone' && Boolean(slow?.failedCategories?.some(isQzoneSearchCategory)))
      : (categoryStates?.[category]?.error ?? quickError);
  const bestRank = (category: SearchCategory | 'app') =>
    category === 'app'
      ? Math.max(0, ...appEntries.map((entry) => appSearchEntryRank(keyword, entry)))
      : Math.max(
          0,
          ...(sections.get(category)?.hits ?? []).map((hit) => searchHitNameRank(hit, keyword)),
        );
  const hasResults = (category: SearchCategory | 'app') =>
    category === 'app' ? appEntries.length > 0 : Boolean(sections.get(category)?.hits?.length);
  const categoryOrder: Array<SearchCategory | 'app'> = [
    ...(appSearchEnabled && onSelectAppEntry ? ['app' as const] : []),
    ...SEARCH_CATEGORY_ORDER.filter((category) => categories.includes(category)),
  ];
  const orderedCategories = categoryOrder
    .map((category, index) => ({
      category,
      index,
      hasResults: hasResults(category),
      rank: bestRank(category),
    }))
    .sort(
      (a, b) => Number(b.hasResults) - Number(a.hasResults) || b.rank - a.rank || a.index - b.index,
    )
    .map((item) => item.category);

  return (
    <div className="weq-search-dropdown" ref={attachRoot}>
      <div
        className="weq-search-scope"
        role="group"
        aria-label="搜索范围"
        {...scopeSelection.rootProps}
      >
        <button
          type="button"
          aria-label="全部范围"
          aria-pressed={allSelected ? true : partiallySelected ? 'mixed' : false}
          onClick={() => {
            onCategoriesChange(allSelected ? [] : [...SEARCH_CATEGORY_ORDER]);
            onAppSearchEnabledChange?.(!allSelected);
          }}
        >
          <Layers size={14} aria-hidden />
          全部
        </button>
        {onSelectAppEntry ? (
          <button
            type="button"
            aria-pressed={appSearchEnabled}
            onClick={() => onAppSearchEnabledChange?.(!appSearchEnabled)}
          >
            <Settings2 size={14} aria-hidden />
            功能与设置
          </button>
        ) : null}
        {scopeOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={option.categories.every((category) => categories.includes(category))}
            {...scopeSelection.itemProps(option.id)}
          >
            <option.Icon size={14} aria-hidden />
            {option.label}
          </button>
        ))}
      </div>
      {hasKeyword ? (
        <>
          <div className="weq-search-index-hint">
            来源：{appSearchEnabled ? '应用功能与设置 · ' : ''}当前账号 · 本地可检索记录
          </div>
          {indexBuilding ? (
            <div className="weq-search-index-hint">
              正在建立本地搜索索引，消息/文件首次查询较慢…
            </div>
          ) : null}
          <div role="listbox" aria-label="搜索结果" aria-busy={quickLoading || slowLoading}>
            {categories.length === 0 && !appSearchEnabled ? (
              <div className="weq-search-empty">未选择搜索范围</div>
            ) : null}
            {orderedCategories.map((category) => {
              if (category === 'app')
                return (
                  <AppSearchResults
                    key="app"
                    keyword={keyword}
                    entries={appEntries}
                    expanded={appResultsExpanded}
                    onExpand={() => setExpandedAppKeyword(keyword)}
                    onSelect={(entry) => {
                      rememberPosition(`app:${entry.id}`);
                      onSelectAppEntry?.(entry);
                    }}
                  />
                );
              const section = sections.get(category)!;
              const hits = section.hits;
              const coverage =
                category === 'chatRecord'
                  ? slow?.messageCoverage
                  : category === 'file'
                    ? slow?.contentCoverage?.groupFile
                    : category === 'qzone'
                      ? qzoneSearchCoverage(slow?.contentCoverage ?? {})
                      : isContentSearchCategory(category)
                        ? slow?.contentCoverage?.[category]
                        : undefined;
              const failed = failedFor(category);
              return (
                <div className="weq-search-section" key={category}>
                  <div className="weq-search-section-header">
                    <span className="weq-search-section-name">{CATEGORY_META[category].label}</span>
                    {hits && hits.length >= 3 ? (
                      <button
                        type="button"
                        className="weq-search-more"
                        data-search-hit-key={`more:${category}`}
                        onClick={() => {
                          rememberPosition(`more:${category}`);
                          onMore(category);
                        }}
                      >
                        更多
                      </button>
                    ) : null}
                  </div>
                  {coverage ? (
                    <div className="weq-search-index-hint">
                      {category === 'file'
                        ? '群文件目录 · '
                        : category === 'chatRecord'
                          ? '频道私聊 · '
                          : ''}
                      {contentCoverageText(coverage)}
                    </div>
                  ) : null}
                  {failed ? (
                    <div className="weq-search-failure" role="status">
                      <span>搜索失败</span>
                      <button
                        type="button"
                        onClick={onRetry}
                        title="重试搜索"
                        aria-label={`重试${CATEGORY_META[category].label}搜索`}
                      >
                        <RotateCw size={14} />
                      </button>
                    </div>
                  ) : null}
                  {section.loading ? (
                    <SearchSectionSkeleton />
                  ) : !hits || hits.length === 0 ? (
                    failed ? null : (
                      <div className="weq-search-empty">无结果</div>
                    )
                  ) : (
                    hits.map((hit) => (
                      <SearchResultCard
                        key={searchHitKey(hit)}
                        hit={hit}
                        keyword={keyword}
                        onSelect={(selected, focusKey) => {
                          rememberPosition(focusKey ?? searchHitKey(selected));
                          onSelect(selected);
                        }}
                      />
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
