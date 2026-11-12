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
import { isLookupNumber } from '../../hooks/useNumberLookup';
import { NumberLookupResults, type OpenNumberProfile } from './NumberLookupResults';
import '../../styles/search-scope.css';
import { SearchResultCard } from './SearchResultCard';
import { SearchSectionSkeleton } from './SearchSkeleton';
import {
  isQzoneSearchCategory,
  qzoneSearchCoverage,
  contentSourcesCoverage,
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
  type ContentSearchHit,
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
  groupBulletin: MessagesSquare,
  groupEssence: MessagesSquare,
  flashFile: FolderOpen,
  qzoneComment: Globe,
  otherQzoneComment: Globe,
  qzonePublicComment: Globe,
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
const scopeIds = scopeOptions.map((option) => option.id);

export function SearchDropdown({
  keyword,
  numberLookupKeyword = keyword,
  onOpenNumberProfile,
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
  numberLookupEnabled = false,
  onNumberLookupEnabledChange,
}: {
  keyword: string;
  numberLookupKeyword?: string;
  onOpenNumberProfile?: OpenNumberProfile;
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
  numberLookupEnabled?: boolean;
  onNumberLookupEnabledChange?: (enabled: boolean) => void;
}): ReactElement {
  const hasKeyword = keyword.trim().length > 0;
  const allSelected =
    SEARCH_CATEGORY_ORDER.every((category) => categories.includes(category)) &&
    (!onSelectAppEntry || appSearchEnabled) &&
    (!onNumberLookupEnabledChange || numberLookupEnabled);
  const partiallySelected = categories.length > 0 || appSearchEnabled || numberLookupEnabled;
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
  const sections = useMemo(() => {
    const contentByCategory = new Map<SearchCategory, ContentSearchHit[]>();
    const qzoneHits: ContentSearchHit[] = [];
    for (const hit of slow?.contentHits ?? []) {
      const category = hit.category;
      const bucket = contentByCategory.get(category);
      if (bucket) bucket.push(hit);
      else contentByCategory.set(category, [hit]);
      if (isQzoneSearchCategory(category)) qzoneHits.push(hit);
    }
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
            ...(contentByCategory.get('groupFile') ?? []),
            ...(contentByCategory.get('flashFile') ?? []),
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
        hits: slow ? (contentByCategory.get(category) ?? []) : null,
        loading: slowLoading && !slow,
      });
    sections.set('qzone', {
      hits: slow ? rankContentSearchHits(keyword, qzoneHits).slice(0, 3) : null,
      loading: slowLoading && !slow,
    });
    for (const [category, section] of sections) {
      const status = categoryStates?.[category];
      if (status) section.loading = status.loading;
    }
    return sections;
  }, [keyword, quick, slow, quickLoading, slowLoading, categoryStates]);

  const indexBuilding =
    categories.some((c) => c === 'chatRecord' || c === 'file') &&
    !slowLoading &&
    slow?.indexStatus === 'building';
  const scopeSelection = useMultiSelection({
    ids: scopeIds,
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
              (source) =>
                source === 'guildMessage' ||
                source === 'cloneMessage' ||
                source === 'groupBulletin' ||
                source === 'groupEssence',
            ),
          )) ||
        (category === 'file' &&
          Boolean(
            slow?.failedCategories?.some(
              (source) => source === 'groupFile' || source === 'flashFile',
            ),
          )) ||
        (category === 'qzone' && Boolean(slow?.failedCategories?.some(isQzoneSearchCategory)))
      : (categoryStates?.[category]?.error ?? quickError);
  const appSectionEnabled = appSearchEnabled && Boolean(onSelectAppEntry);
  const orderedCategories = useMemo(() => {
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
      ...(appSectionEnabled ? ['app' as const] : []),
      ...SEARCH_CATEGORY_ORDER.filter((category) => categories.includes(category)),
    ];
    return categoryOrder
      .map((category, index) => ({
        category,
        index,
        hasResults: hasResults(category),
        rank: bestRank(category),
      }))
      .sort(
        (a, b) =>
          Number(b.hasResults) - Number(a.hasResults) || b.rank - a.rank || a.index - b.index,
      )
      .map((item) => item.category);
  }, [appSectionEnabled, appEntries, sections, categories, keyword]);

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
            onNumberLookupEnabledChange?.(!allSelected);
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
        {onNumberLookupEnabledChange ? (
          <button
            type="button"
            aria-pressed={numberLookupEnabled}
            onClick={() => onNumberLookupEnabledChange(!numberLookupEnabled)}
          >
            <Hash size={14} aria-hidden />
            QQ号/群号
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
            来源：{appSearchEnabled ? '应用功能与设置 · ' : ''}
            {numberLookupEnabled && isLookupNumber(numberLookupKeyword) ? 'QQ 在线资料 · ' : ''}
            当前账号 · 本地可检索记录
          </div>
          {indexBuilding ? (
            <div className="weq-search-index-hint">
              正在校验 QQ 搜索索引，消息/文件首次查询可能较慢…
            </div>
          ) : null}
          <div role="listbox" aria-label="搜索结果" aria-busy={quickLoading || slowLoading}>
            {categories.length === 0 && !appSearchEnabled && !numberLookupEnabled ? (
              <div className="weq-search-empty">未选择搜索范围</div>
            ) : null}
            {numberLookupEnabled && isLookupNumber(numberLookupKeyword) ? (
              <NumberLookupResults
                keyword={numberLookupKeyword}
                onOpenProfile={onOpenNumberProfile}
              />
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
                    ? contentSourcesCoverage(slow?.contentCoverage ?? {}, [
                        'groupFile',
                        'flashFile',
                      ])
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
