import { Suspense, type ComponentProps, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { useSearchReturn } from '../../hooks/useSearchReturn';
import { SearchDropdown } from './SearchDropdown';
import { SearchMoreResults } from './UnifiedSearchModal';
import { ChatRecordsModal } from './ChatRecordsModal';
import { isInlineSearchHit } from './searchNavigation';
import { CATEGORY_META, type SearchHit } from './types';

export function SearchResultsPanel({
  navigation,
  onJumpMessage,
  renderers,
  renderDetail,
  ...props
}: Omit<ComponentProps<typeof SearchDropdown>, 'onMore' | 'onNavigate' | 'initialPosition'> & {
  navigation: ReturnType<typeof useSearchReturn>;
  onJumpMessage: ComponentProps<typeof ChatRecordsModal>['onJumpMessage'];
  renderers?: ComponentProps<typeof ChatRecordsModal>['renderers'];
  renderDetail: (hit: SearchHit, onBack: () => void) => ReactNode;
}) {
  const select = (hit: SearchHit) => {
    const bulletinGroup =
      hit.category === 'chatRecord' && hit.source === 'group' && hit.matchedBulletins
        ? { code: hit.targetUid, name: hit.name }
        : hit.category === 'groupBulletin' && hit.target.kind === 'groupBulletin'
          ? { code: hit.target.groupCode, name: hit.target.groupCode }
          : null;
    if (bulletinGroup) {
      props.onSelect({
        category: 'group',
        groupCode: bulletinGroup.code,
        name: bulletinGroup.name,
        remark: '',
        inDirectory: false,
        hasConversation: true,
        aliases: [],
      });
    } else if (isInlineSearchHit(hit)) navigation.openDetail(hit);
    else props.onSelect(hit);
  };
  if (navigation.detail) {
    const hit = navigation.detail;
    return (
      <div className="weq-search-dropdown weq-search-detail">
        <header className="weq-search-more-head">
          <button
            type="button"
            className="weq-search-more-back"
            title="返回搜索结果"
            aria-label="返回搜索结果"
            onClick={navigation.backDetail}
          >
            <ArrowLeft size={18} aria-hidden />
          </button>
          <h3 className="weq-search-more-title">
            {hit.category === 'chatRecord' ? hit.name : CATEGORY_META[hit.category].label}
          </h3>
        </header>
        <div className="weq-search-detail-body">
          <Suspense
            fallback={
              <div className="weq-search-empty" role="status">
                正在加载
              </div>
            }
          >
            {hit.category === 'chatRecord' ? (
              <ChatRecordsModal
                initialHit={hit}
                initialKeyword={props.keyword}
                embeddedKeyword={props.keyword}
                onClose={navigation.backDetail}
                onJumpMessage={onJumpMessage}
                renderers={renderers}
              />
            ) : (
              renderDetail(hit, navigation.backDetail)
            )}
          </Suspense>
        </div>
      </div>
    );
  }
  if (navigation.category) {
    return (
      <SearchMoreResults
        key={navigation.category}
        category={navigation.category}
        keyword={props.keyword}
        sources={props.sources}
        initialSnapshot={navigation.moreSnapshot}
        onSnapshot={navigation.rememberMore}
        onNavigate={navigation.rememberMore}
        onBack={navigation.back}
        onSelect={select}
        onOpenChatRecords={select}
      />
    );
  }
  return (
    <SearchDropdown
      {...props}
      onSelect={select}
      initialPosition={
        navigation.target?.kind === 'dropdown' ? navigation.target.position : undefined
      }
      onNavigate={(position) => navigation.remember({ kind: 'dropdown', position })}
      onMore={navigation.expand}
    />
  );
}
