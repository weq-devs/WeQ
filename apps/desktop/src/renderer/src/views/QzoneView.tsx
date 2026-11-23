/** Qzone's known web capabilities, rendered in the local WeQ UI. */
import { ToolbarLabel } from '../components/CompactToolbar';
import { observeCompactToolbar } from '../components/CompactToolbar.shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  defaultRangeExtractor,
  measureElement,
  observeElementOffset,
  observeElementRect,
  useVirtualizer,
} from '@tanstack/react-virtual';
import { FormSelect } from '../components/FormSelect';
import { NumericText } from '../components/NumericText';
import { EmptyState } from '../components/EmptyState';
import { QZONE_SECTION_FEATURES, type QzoneFeatureSection } from '@weq/service/feature-catalog';
import {
  useCallback,
  useLayoutEffect,
  memo,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  AtSign,
  ArrowLeft,
  Download,
  ChevronDown,
  Eye,
  ImagePlus,
  Loader2,
  Lock,
  MessageCircle,
  Plus,
  RefreshCw,
  Repeat2,
  Send,
  Settings,
  ThumbsUp,
  X,
  Images,
} from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { z } from 'zod';
import { PageSnapshotScope } from '../components/PageSnapshots';
import { usePageDataCache, usePageState } from '../components/PageSnapshots.shared';
import { PageScrollSnapshot } from '../components/PageScrollSnapshot';
import { PageDataCache } from '../lib/pageDataCache';
import { TabActivity } from '../components/RetainedTabs';
import { useTabActive } from '../components/RetainedTabs.shared';
import { pageValue } from '../lib/pageSnapshots';
import {
  QzoneName,
  QzonePersonIdentity,
  QzonePersonButton,
  QzonePersonHeader,
  QzoneProfileAvatar,
} from '../components/QzoneProfileAvatar';
import {
  useContentMultiSelect,
  useCurrentContentSelection,
  useRequestContentExport,
} from '../state/contentSelection.shared';
import { useMultiSelection, type MultiSelectionItemProps } from '../hooks/useMultiSelection';
import { QzoneAlbumDestination, QzoneAlbumDialog } from '../components/QzoneAlbumDialog';
import { TransferRing } from '../components/TransferRing';
import { QzoneFeedLinks } from '../components/QzoneFeedLinks';
import { QzoneTime } from '../components/QzoneTime';
import { QzoneWriteActions, type QzoneLikeChange } from '../components/qq-actions/MediaActions';
import { withQQAccountScope } from '../components/qq-actions/shared.shared';
import { pushMobileBack, useMobileBack } from '../hooks/useMobileNavigation';
import { QzoneEmoji, QzoneInlineText } from '../components/QzoneEmoji';
import {
  projectQzoneFeed,
  mergeQzonePosts,
  mergeQzonePostImages,
  qzoneFriendFeedKey,
  qzonePlainText,
  qzoneTextParts,
} from '../lib/qzone';
import { Modal } from '../components/Dialog';
import { OverlayLayer } from '../components/OverlayLayer';
import { QzoneSettingsSection } from '../components/settings/QzoneSettingsSection';
import { useToast } from '../components/Toast.shared';
import type {
  QzoneEmotion,
  QzoneFeed,
  QzoneInteraction,
  QzoneLikesResult,
  QzonePublication,
} from './qzone_types';
import { QzoneAutoPage, QzonePageButton } from './QzonePagination';
import { LoadingStatus, QzoneMediaGrid, State } from './qzoneShared';
import {
  QzonePageContext,
  QzoneReadPauseContext,
  moreSpacePanes,
  useNearViewport,
  type QzoneHomeDestination,
  type QzoneMorePane,
} from './qzoneShared.shared';
import '../styles/qzone.css';
import {
  QzoneProfileContext,
  QzonePersonContext,
  QzoneAlbumNavigationContext,
  QzoneMediaNavigationContext,
  type QzoneAlbumRequest,
  type QzoneMediaDestination,
  type QzoneSpaceRequest,
} from '../lib/qzoneNavigation';
import { QZONE_IMAGE_MAX_BYTES, QZONE_VISIBILITY } from '../../../shared/qzone';
import { stageAccountFile } from '../lib/accountFilePicker';
import { IS_WEB } from '../lib/target.shared';
import { QzoneSpaceHome, type QzoneHomePostProps } from './QzoneSpaceHome';
import { QzoneBlogs } from './QzoneBlogs';
import { useQzoneBlogIndex } from './QzoneBlogs.shared';
import { QzoneMore } from './QzoneMore';
import { useQzoneShareIndex } from './QzoneMore.shared';
import { QzonePublicPane } from './QzonePublicView';
import { QzonePostForwardDialog } from '../components/QzonePostForwardDialog';
import { QzoneActionsRow, QzoneCommentToggle } from '../components/QzoneActionsRow';
import { QzoneCommentRow } from '../components/QzoneCommentRow';
import { QzoneForwardAction } from '../components/QzoneForwardAction';
import { ContentReferenceToolbar } from '../components/ContentReferenceToolbar';
import { contentReferenceKey, type ContentReference } from '../../../shared/content_selection';
import { QzoneLikesPopover } from '../components/QzoneLikesPopover';
import { QzonePostArchive } from '../components/QzoneUpvoteAction';
import { QzonePublicNavigationContext } from '../lib/qzoneNavigation';
import { QzoneRelatedRound, qzoneSelfLiked, type QzoneReplyTarget } from '../lib/qzoneActions';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import { completeQzonePostText, qzoneImageCompletionScope } from '../lib/qzoneCompletion';
import {
  mergeQzoneHomePost,
  qzoneHomePostPreview,
  type QzoneHomeAlbumMedia,
} from '../lib/qzonePublic';
import { qzoneReplyPresentation } from '../lib/qzoneReplyPresentation';
import {
  QzonePeopleContext,
  qzoneDisplayName,
  qzoneNickname,
  type QzoneLocalProfile,
  type QzoneNamePriority,
} from '../lib/qzonePeople';
import {
  projectQzoneRelated,
  qzoneRelatedKey,
  relatedPostExcerpt,
  relatedActionLine,
  relatedCommentTarget,
  type RelatedComment,
  type RelatedActivity,
  type RelatedKind,
} from '../lib/qzoneRelated';

type OwnerTab = 'space' | 'person-posts';
type Tab = QzoneFeatureSection | OwnerTab;

function requestedOwnerTab(request: QzoneSpaceRequest): OwnerTab {
  const kind = request.target?.kind;
  return kind === 'post' || kind === 'unlocated-post' ? 'person-posts' : 'space';
}

const linkedPostRequestsSchema = z.record(
  z.object({
    revision: z.string(),
    nickname: z.string().optional(),
    tid: z.string().optional(),
    commentId: z.string().optional(),
    parentCommentId: z.string().optional(),
    replyId: z.string().optional(),
  }),
);

function withoutOwner<T>(current: Record<string, T>, uin: string): Record<string, T> {
  if (!Object.hasOwn(current, uin)) return current;
  const next = { ...current };
  delete next[uin];
  return next;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '加载失败，请重试。';

const QzoneReadsEnabled = createContext(true);
const PinFeedCard = createContext<((pinned: boolean) => void) | null>(null);
const FeedCardData = createContext<PageDataCache | null>(null);
const TIMELINE_REENTRY_REFRESH_MS = 5 * 60_000;

/** 长列表切换栏目时保留已读卡片和图片；其它子页仍按需挂载。 */
function QzonePage({
  active,
  refreshKey,
  resetScrollKey,
  pauseReadsDuringNavigation = true,
  retainTimeline = false,
  children,
}: {
  active: boolean;
  refreshKey: number;
  resetScrollKey?: string;
  pauseReadsDuringNavigation?: boolean;
  retainTimeline?: boolean;
  children: ReactElement;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const readsEnabled = useContext(QzoneReadsEnabled);
  const activity = useQQReadActivity(active && (!pauseReadsDuringNavigation || readsEnabled), {
    remoteCache: true,
  });
  const position = useRef(0);
  const previousActive = useRef(false);
  const previousScrollKey = useRef<string | undefined>(undefined);
  const leftAt = useRef<number | null>(null);
  const [entry, setEntry] = useState({ active, visited: active, refresh: 0 });
  let entryRefresh = entry.refresh;
  if (entry.active !== active) {
    if (
      active &&
      position.current <= 48 &&
      (!retainTimeline ||
        (leftAt.current !== null && Date.now() - leftAt.current >= TIMELINE_REENTRY_REFRESH_MS))
    )
      entryRefresh++;
    setEntry({ active, visited: entry.visited || active, refresh: entryRefresh });
  }
  useLayoutEffect(() => {
    const reset = active && resetScrollKey !== previousScrollKey.current;
    if (reset) {
      position.current = 0;
      previousScrollKey.current = resetScrollKey;
    }
    if (active && (reset || !previousActive.current)) {
      if (scroll.current) scroll.current.scrollTop = position.current;
    }
    if (!active && previousActive.current) leftAt.current = Date.now();
    previousActive.current = active;
  }, [active, resetScrollKey]);
  const refresh = refreshKey + entryRefresh + (retainTimeline ? 0 : activity.revision);
  const context = useMemo(
    () => ({ active: activity.enabled, refresh }),
    [activity.enabled, refresh],
  );
  return (
    <div
      className="weq-qzn-scroll"
      data-weq-windowed-list={retainTimeline ? '' : undefined}
      hidden={!active}
      ref={scroll}
      onScroll={(event) => {
        if (active) position.current = event.currentTarget.scrollTop;
      }}
    >
      <QzonePageContext.Provider value={context}>
        {active || (retainTimeline && entry.visited) ? children : null}
      </QzonePageContext.Provider>
    </div>
  );
}

/** 停稳后首次挂载；暂停读取时保留当前画面，离开工作区仍卸载。 */
export const QzoneWorkspace = memo(function QzoneWorkspace({
  active,
  readEnabled = active,
  selfUin,
  nickname,
  localProfiles,
  spaceRequest,
  onSpaceChange,
}: {
  active: boolean;
  readEnabled?: boolean;
  selfUin: string;
  nickname: string;
  localProfiles?: ReadonlyMap<string, QzoneLocalProfile>;
  spaceRequest?: QzoneSpaceRequest | null;
  onSpaceChange?: (uin: string) => void;
}) {
  const parentActive = useTabActive();
  const [loaded, setLoaded] = useState(readEnabled);
  if (readEnabled && !loaded) setLoaded(true);
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active && parentActive && readEnabled,
  });
  if (active && parentActive && !loaded && !readEnabled)
    return (
      <TabActivity active={false}>
        <PageSnapshotScope name="qzone-preview">
          <QzoneView active={false} loadingPreview selfUin={selfUin} nickname={nickname} />
        </PageSnapshotScope>
      </TabActivity>
    );
  // 暂停数据读取不能撤销返回手势，否则退栈动画会再次暂停读取。
  return active && parentActive && (loaded || readEnabled) ? (
    <QzoneReadsEnabled.Provider value={readEnabled}>
      <PageSnapshotScope name="qzone">
        <PageScrollSnapshot style={{ height: '100%', minHeight: 0 }}>
          <QzoneView
            active={active}
            selfUin={selfUin}
            nickname={nickname}
            localProfiles={localProfiles}
            spaceRequest={spaceRequest}
            onSpaceChange={onSpaceChange}
            personClickAction={settings.data?.qzonePersonClickAction ?? 'space'}
            namePriority={settings.data?.qzoneNamePriority}
          />
        </PageScrollSnapshot>
      </PageSnapshotScope>
    </QzoneReadsEnabled.Provider>
  ) : null;
});

function useQzoneNicknames(selfUin: string, enabled: boolean) {
  const [names, setNames] = useState<Record<string, string>>({});
  const known = useRef(names);
  known.current = names;
  const pending = useRef(new Set<string>());
  const attempts = useRef(new Map<string, number>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(enabled);
  active.current = enabled;
  const { run, cancel } = useQzoneRequests();
  const request = useCallback(
    (uin: string) => {
      if (
        !enabled ||
        !active.current ||
        !/^[1-9]\d{4,19}$/.test(uin) ||
        known.current[uin] ||
        Date.now() - (attempts.current.get(uin) ?? 0) < 60000
      )
        return;
      attempts.current.set(uin, Date.now());
      pending.current.add(uin);
      if (timer.current !== undefined) return;
      const flush = (): void => {
        timer.current = undefined;
        if (!active.current) return;
        for (const id of pending.current) if (known.current[id]) pending.current.delete(id);
        const uins = [...pending.current].slice(0, 200);
        if (!uins.length) return;
        for (const id of uins) pending.current.delete(id);
        if (pending.current.size) timer.current = setTimeout(flush, 250);
        void run(
          (requestId) => client.account.qzone.people.query({ selfUin, requestId, uins }),
          true,
        )
          .then((result) => {
            if (!active.current) return;
            const resolved = Object.entries(result).filter(([id, name]) => qzoneNickname(id, name));
            if (resolved.length)
              setNames((current) => ({ ...current, ...Object.fromEntries(resolved) }));
          })
          .catch(() => {
            /* Preserve the supplied display name when a public nickname is unavailable. */
          });
      };
      timer.current = setTimeout(flush, 80);
    },
    [selfUin, run, enabled],
  );
  useEffect(() => {
    active.current = enabled;
    return () => {
      active.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
      for (const id of attempts.current.keys()) if (!known.current[id]) attempts.current.delete(id);
      cancel();
    };
  }, [enabled, cancel]);
  return useMemo(() => ({ names, request }), [names, request]);
}

function QzoneText({
  content,
  onSpace,
}: {
  content: string;
  onSpace: (uin: string, nickname?: string) => void;
}) {
  return (
    <>
      {qzoneTextParts(content).map((part) =>
        part.kind === 'mention' ? (
          <QzonePersonButton
            key={`${part.offset}:${part.uin}`}
            className="weq-qzn-mention"
            uin={part.uin}
            nickname={part.text.slice(1)}
            onSpace={onSpace}
          >
            <span className="weq-qzn-name">
              <QzoneInlineText content={part.text} />
            </span>
          </QzonePersonButton>
        ) : part.kind === 'emoji' ? (
          <QzoneEmoji key={`${part.offset}:${part.code}`} code={part.code} />
        ) : (
          <span key={`${part.offset}:text`}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function QzoneView({
  selfUin,
  nickname,
  localProfiles,
  active = true,
  loadingPreview = false,
  spaceRequest,
  onSpaceChange,
  personClickAction = 'space',
  namePriority = 'remark',
}: {
  selfUin: string;
  nickname: string;
  localProfiles?: ReadonlyMap<string, QzoneLocalProfile>;
  active?: boolean;
  loadingPreview?: boolean;
  spaceRequest?: QzoneSpaceRequest | null;
  /** 当前正在看谁的空间（自己或好友的 QQ 号），供浮动工具按当前位置导出。 */
  onSpaceChange?: (uin: string) => void;
  personClickAction?: 'profile' | 'space';
  namePriority?: QzoneNamePriority;
}): ReactElement {
  const readsEnabled = useContext(QzoneReadsEnabled);
  const activity = useQQReadActivity(active && readsEnabled, { remoteCache: true });
  const { names, request } = useQzoneNicknames(selfUin, activity.enabled);
  const initialSpace = spaceRequest?.accountUin === selfUin ? spaceRequest : null;
  const initialSection = initialSpace ? requestedOwnerTab(initialSpace) : null;
  const initialTab =
    initialSpace?.catalog?.section ??
    (initialSection === 'space' && initialSpace?.uin === selfUin
      ? 'posts'
      : (initialSection ?? 'feeds'));
  const [tab, setTab] = usePageState<Tab>(
    'tab',
    initialTab,
    z.enum(['feeds', 'posts', 'space', 'person-posts', 'related', 'public']),
  );
  const [handledRequest, setHandledRequest] = usePageState<string | null>(
    'handled-request',
    null,
    pageValue.optionalString,
  );
  const tabBar = useRef<HTMLElement>(null);
  const [hostUin, setHostUin] = usePageState(
    'host',
    initialSpace?.uin ?? selfUin,
    pageValue.string,
  );
  // 把自己的空间状态同步给外层（浮动工具按当前位置导出当前空间）。
  useEffect(() => {
    onSpaceChange?.(hostUin);
  }, [hostUin, onSpaceChange]);
  const [spaces, setSpaces] = usePageState<string[]>(
    'spaces',
    initialSpace && initialTab === 'space' ? [initialSpace.uin] : [],
    pageValue.strings,
  );
  const [postOwners, setPostOwners] = usePageState<string[]>(
    'post-owners',
    initialSpace && initialTab === 'person-posts' ? [initialSpace.uin] : [],
    pageValue.strings,
  );
  const [spaceNames, setSpaceNames] = useState<Record<string, string>>(
    initialSpace?.nickname && initialSpace.nickname !== initialSpace.uin
      ? { [initialSpace.uin]: initialSpace.nickname }
      : {},
  );
  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});
  const rememberOwnerName = useCallback((uin: string, name: string) => {
    const value = qzoneNickname(uin, name);
    if (!value) return;
    setOwnerNames((current) => (current[uin] === value ? current : { ...current, [uin]: value }));
  }, []);
  const profilesByUin = useMemo(() => {
    const profiles = new Map<string, QzoneLocalProfile>();
    for (const profile of localProfiles?.values() ?? []) profiles.set(profile.uin, profile);
    return profiles;
  }, [localProfiles]);
  const people = useMemo(
    () => ({
      namePriority,
      nickname: (uin: string, fallback?: string) =>
        (uin === selfUin ? qzoneNickname(uin, nickname) : '') ||
        qzoneNickname(uin, profilesByUin.get(uin)?.nick) ||
        qzoneNickname(uin, ownerNames[uin]) ||
        qzoneNickname(uin, names[uin]) ||
        qzoneNickname(uin, fallback),
      remark: (uin: string) => {
        const profile = profilesByUin.get(uin);
        return uin !== selfUin && profile?.isFriend ? qzoneNickname(uin, profile.remark) : '';
      },
      request,
    }),
    [selfUin, nickname, profilesByUin, ownerNames, names, namePriority, request],
  );
  const [albumRequests, setAlbumRequests] = useState<Record<string, QzoneAlbumRequest>>({});
  const [postRequests, setPostRequests] = usePageState(
    'linked-posts',
    {},
    linkedPostRequestsSchema,
  );
  const rememberSpaceName = useCallback((uin: string, name: string) => {
    const value = qzoneNickname(uin, name);
    if (!value) return;
    setSpaceNames((current) =>
      current[uin] && current[uin] !== uin ? current : { ...current, [uin]: value },
    );
  }, []);
  const [inputUin, setInputUin] = usePageState('input', '', pageValue.string);
  const [targetError, setTargetError] = useState('');
  const [visitOpen, setVisitOpen] = useState(false);
  const visitTrigger = useRef<HTMLButtonElement>(null);
  const visitId = useId();
  const focusVisitInput = useCallback((element: HTMLInputElement | null) => {
    element?.focus({ preventScroll: true });
  }, []);
  const closeVisit = () => {
    setVisitOpen(false);
    setTargetError('');
    visitTrigger.current?.focus({ preventScroll: true });
  };
  const requestExport = useRequestContentExport();
  const contentSelection = useCurrentContentSelection();
  const [refreshes, setRefreshes] = useState<Record<string, number>>({});
  const [visited, setVisited] = useState<Tab[]>([tab]);
  useEffect(() => {
    setVisited((current) => (current.includes(tab) ? current : [...current, tab]));
  }, [tab]);
  const spaceNickname = (uin: string) =>
    people.nickname(uin, spaceNames[uin] || postRequests[uin]?.nickname) || uin;
  const activeTabName =
    tab === 'space' || tab === 'person-posts'
      ? qzoneDisplayName(hostUin, spaceNickname(hostUin), people.remark(hostUin), namePriority)
      : '';
  useLayoutEffect(() => {
    const bar = tabBar.current;
    const selected = bar?.querySelector<HTMLElement>('[aria-current="page"]');
    const item = selected?.closest<HTMLElement>('.weq-qzn-space-tab') ?? selected;
    if (!bar || !item) return;
    const bounds = bar.getBoundingClientRect();
    const target = item.getBoundingClientRect();
    if (target.left < bounds.left) bar.scrollLeft += target.left - bounds.left;
    else if (target.right > bounds.right) bar.scrollLeft += target.right - bounds.right;
  }, [tab, hostUin, activeTabName]);
  const refreshPage = (key: string) =>
    setRefreshes((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
  const [compose, setCompose] = useState(false);
  const [publication, setPublication] = useState<QzonePublication | null>(null);
  const toast = useToast((state) => state.push);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const navigationBacks = useRef<Array<() => void>>([]);
  useEffect(
    () => () => {
      for (const remove of navigationBacks.current.splice(0)) remove();
    },
    [active],
  );
  const openSpace = useCallback(
    (uin: string, name?: string, section: OwnerTab = 'space'): boolean => {
      const value = uin.trim();
      if (!/^[1-9]\d{4,19}$/.test(value)) {
        setTargetError('请输入有效的 QQ 号');
        return false;
      }
      setTargetError('');
      const nextTab = section === 'space' && value === selfUin ? 'posts' : section;
      if (value !== hostUin || tab !== nextTab) {
        const previousTab = tab,
          previousHost = hostUin;
        const remove = pushMobileBack(
          () => {
            setTab(previousTab);
            setHostUin(previousHost);
            navigationBacks.current = navigationBacks.current.filter((item) => item !== remove);
          },
          () => document.querySelector<HTMLElement>('.weq-qzn'),
          30,
        );
        navigationBacks.current.push(remove);
      }
      if (name) rememberSpaceName(value, name);
      setHostUin(value);
      if (nextTab !== 'posts') {
        const setOwners = nextTab === 'person-posts' ? setPostOwners : setSpaces;
        setOwners((current) => (current.includes(value) ? current : [...current, value]));
      }
      setTab(nextTab);
      return true;
    },
    [selfUin, hostUin, tab, rememberSpaceName, setTab, setSpaces, setPostOwners, setHostUin],
  );
  useEffect(() => {
    if (
      !active ||
      !spaceRequest ||
      spaceRequest.accountUin !== selfUin ||
      handledRequest === spaceRequest.revision
    )
      return;
    setHandledRequest(spaceRequest.revision);
    if (spaceRequest.catalog) {
      const { section } = spaceRequest.catalog;
      if (section === 'posts') setHostUin(selfUin);
      setTab(section);
      return;
    }
    const target = spaceRequest.target;
    openSpace(spaceRequest.uin, spaceRequest.nickname, requestedOwnerTab(spaceRequest));
    if (target?.kind === 'album')
      setAlbumRequests((current) => ({
        ...current,
        [spaceRequest.uin]: {
          hostUin: spaceRequest.uin,
          topicId: target.topicId,
          name: '',
          revision: spaceRequest.revision,
        },
      }));
    if (target?.kind === 'post' || target?.kind === 'unlocated-post') {
      setPostRequests((current) => ({
        ...current,
        [spaceRequest.uin]: {
          revision: spaceRequest.revision,
          nickname: spaceRequest.nickname,
          ...(target.kind === 'post'
            ? {
                tid: target.tid,
                commentId: target.commentId,
                parentCommentId: target.parentCommentId,
                replyId: target.replyId,
              }
            : {}),
        },
      }));
    }
  }, [
    active,
    selfUin,
    spaceRequest,
    openSpace,
    handledRequest,
    setHandledRequest,
    setPostRequests,
    setHostUin,
    setTab,
  ]);
  const currentOwner = tab === 'space' || tab === 'person-posts' ? hostUin : selfUin;
  const linkedTid = tab === 'person-posts' ? postRequests[hostUin]?.tid : undefined;
  const closeOwnerTab = (section: OwnerTab, uin: string) => {
    if (section === 'space') {
      setSpaces((current) => current.filter((value) => value !== uin));
      setAlbumRequests((current) => withoutOwner(current, uin));
    } else {
      setPostOwners((current) => current.filter((value) => value !== uin));
      setPostRequests((current) => withoutOwner(current, uin));
    }
    if (!(section === 'space' ? postOwners : spaces).includes(uin)) {
      setSpaceNames((current) => withoutOwner(current, uin));
      setOwnerNames((current) => withoutOwner(current, uin));
    }
    if (tab === section && hostUin === uin) {
      setHostUin(selfUin);
      setTab('feeds');
    }
  };
  const workspace = (
    <QzonePeopleContext.Provider value={people}>
      <section
        className="weq-qzn"
        aria-label="QQ 空间"
        data-qzone-loading-preview={loadingPreview || undefined}
      >
        <header ref={observeCompactToolbar} className="weq-qzn-header">
          <div className="weq-qzn-identity">
            <QzoneProfileAvatar uin={selfUin} nickname={nickname} size={36} />
            <div>
              <strong>QQ 空间</strong>
              <QzonePersonButton uin={selfUin} nickname={nickname}>
                <QzoneName content={nickname} uin={selfUin} />
              </QzonePersonButton>
            </div>
          </div>
          <div className="weq-qzn-tools" data-toolbar-group="">
            <button
              type="button"
              title="空间设置"
              aria-label="空间设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={17} />
            </button>
            <button
              type="button"
              title="导出说说"
              aria-label="导出说说"
              disabled={!requestExport || (tab === 'person-posts' && !linkedTid)}
              onClick={() => {
                const uin = currentOwner;
                if (tab === 'person-posts') {
                  if (linkedTid)
                    requestExport?.({
                      owner: { kind: 'qzone-posts', container: uin },
                      scope: { type: 'items', ids: [linkedTid] },
                    });
                  return;
                }
                requestExport?.(
                  contentSelection?.owner.kind === 'qzone-posts' &&
                    contentSelection.owner.container === uin
                    ? contentSelection
                    : { owner: { kind: 'qzone-posts', container: uin }, scope: { type: 'all' } },
                );
              }}
            >
              <Download size={17} />
            </button>
            <button
              title="写说说"
              type="button"
              className="weq-qzn-primary"
              onClick={() => setCompose(true)}
            >
              <Send size={15} />
              <ToolbarLabel>写说说</ToolbarLabel>
            </button>
          </div>
        </header>
        <div className="weq-qzn-navigation">
          <nav ref={tabBar} aria-label="空间栏目">
            <button
              type="button"
              aria-current={tab === 'feeds' ? 'page' : undefined}
              onClick={() => {
                if (tab === 'feeds') refreshPage('feeds');
                else setTab('feeds');
              }}
            >
              {QZONE_SECTION_FEATURES.feeds.label}
            </button>
            <button
              type="button"
              aria-current={tab === 'public' ? 'page' : undefined}
              onClick={() => setTab('public')}
            >
              {QZONE_SECTION_FEATURES.public.label}
            </button>
            <button
              type="button"
              aria-current={tab === 'related' ? 'page' : undefined}
              onClick={() => setTab('related')}
            >
              {QZONE_SECTION_FEATURES.related.label}
            </button>
            <button
              type="button"
              aria-current={tab === 'posts' ? 'page' : undefined}
              onClick={() => {
                setHostUin(selfUin);
                setTab('posts');
              }}
            >
              {QZONE_SECTION_FEATURES.posts.label}
            </button>
            {(['space', 'person-posts'] as const).flatMap((section) =>
              (section === 'space' ? spaces : postOwners).map((uin) => {
                const postsOnly = section === 'person-posts';
                const name = spaceNickname(uin);
                const label = qzoneDisplayName(uin, name, people.remark(uin), namePriority);
                const ownPosts = postsOnly && uin === selfUin;
                const suffix = postsOnly ? '的说说' : '的空间';
                return (
                  <span className="weq-qzn-space-tab" key={`${section}:${uin}`}>
                    <button
                      type="button"
                      className="weq-qzn-space-title"
                      aria-current={tab === section && hostUin === uin ? 'page' : undefined}
                      onClick={() => {
                        setHostUin(uin);
                        setTab(section);
                      }}
                    >
                      <span className="weq-qzn-space-label">
                        {ownPosts ? (
                          '我的说说'
                        ) : (
                          <>
                            <QzoneName content={name} uin={uin} /> {suffix}
                          </>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={
                        ownPosts ? '关闭我的说说' : `关闭 ${qzonePlainText(label)} ${suffix}`
                      }
                      onClick={() => closeOwnerTab(section, uin)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              }),
            )}
          </nav>
          <button
            ref={visitTrigger}
            className="weq-qzn-visit-trigger"
            type="button"
            aria-label="按 QQ 号访问空间"
            title="按 QQ 号访问空间"
            aria-haspopup="dialog"
            aria-expanded={visitOpen}
            aria-controls={visitOpen ? visitId : undefined}
            onClick={() => (visitOpen ? closeVisit() : setVisitOpen(true))}
          >
            <Plus size={18} aria-hidden />
          </button>
          {visitOpen && active ? (
            <OverlayLayer presentation="popover" anchor={visitTrigger.current} onClose={closeVisit}>
              <form
                id={visitId}
                className="weq-qzn-visit-popover"
                role="dialog"
                aria-label="按 QQ 号访问空间"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (openSpace(inputUin)) closeVisit();
                }}
              >
                <label htmlFor={`${visitId}-uin`}>QQ 号</label>
                <div>
                  <input
                    id={`${visitId}-uin`}
                    ref={focusVisitInput}
                    value={inputUin}
                    onChange={(event) => {
                      setInputUin(event.target.value);
                      setTargetError('');
                    }}
                    aria-invalid={Boolean(targetError)}
                    aria-describedby={targetError ? `${visitId}-error` : undefined}
                    inputMode="numeric"
                  />
                  <button type="submit">查看</button>
                </div>
                {targetError ? (
                  <p id={`${visitId}-error`} role="alert">
                    {targetError}
                  </p>
                ) : null}
              </form>
            </OverlayLayer>
          ) : null}
        </div>
        {loadingPreview ? (
          <div className="weq-mobile-qzone-skeleton" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <div key={row}>
                <i />
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : null}
        {visited.includes('feeds') || tab === 'feeds' ? (
          <QzonePage
            active={active && tab === 'feeds'}
            refreshKey={refreshes.feeds ?? 0}
            retainTimeline
          >
            <Feeds selfUin={selfUin} onSpace={openSpace} />
          </QzonePage>
        ) : null}
        {visited.includes('related') || tab === 'related' ? (
          <QzonePage active={active && tab === 'related'} refreshKey={refreshes.related ?? 0}>
            <FeedTimeline selfUin={selfUin} kind="related" onSpace={openSpace} />
          </QzonePage>
        ) : null}
        {visited.includes('public') || tab === 'public' ? (
          <QzonePage active={active && tab === 'public'} refreshKey={refreshes.public ?? 0}>
            <QzonePublicPane selfUin={selfUin} onSpace={openSpace} />
          </QzonePage>
        ) : null}
        {visited.includes('posts') || tab === 'posts' ? (
          <SpaceContent
            active={active && tab === 'posts'}
            refreshKey={refreshes.posts ?? 0}
            selfUin={selfUin}
            hostUin={selfUin}
            nickname={nickname}
            albumRequest={albumRequests[selfUin]}
            publication={publication}
            onSpace={openSpace}
            onOwnerNickname={rememberOwnerName}
          />
        ) : null}
        {spaces.map((uin) => (
          <SpaceContent
            key={uin}
            active={active && tab === 'space' && hostUin === uin}
            refreshKey={refreshes[`space:${uin}`] ?? 0}
            selfUin={selfUin}
            hostUin={uin}
            nickname={spaceNickname(uin)}
            albumRequest={albumRequests[uin]}
            onSpace={openSpace}
            onOwnerNickname={rememberOwnerName}
          />
        ))}
        {postOwners.map((uin) => {
          const request = postRequests[uin];
          const ownerName = spaceNickname(uin);
          const commentText =
            initialSpace?.revision === request?.revision && initialSpace?.target?.kind === 'post'
              ? initialSpace.target.commentText
              : undefined;
          return (
            <QzonePage
              key={uin}
              active={active && tab === 'person-posts' && hostUin === uin}
              refreshKey={0}
            >
              <div className="weq-qzn-timeline">
                {request?.tid ? (
                  <LinkedPost
                    key={request.revision}
                    selfUin={selfUin}
                    hostUin={uin}
                    tid={request.tid}
                    focusComment={
                      request.commentId
                        ? {
                            id: request.commentId,
                            uin: '',
                            content: commentText ?? '',
                            images: [],
                            parentCommentId: request.parentCommentId,
                            replyId: request.replyId,
                            isReply: Boolean(request.parentCommentId),
                            source: 'search',
                          }
                        : undefined
                    }
                    nickname={ownerName}
                    onSpace={openSpace}
                  />
                ) : (
                  <p className="weq-qzn-status">无法定位这条说说</p>
                )}
              </div>
            </QzonePage>
          );
        })}
        {compose && active ? (
          <Composer
            selfUin={selfUin}
            onClose={() => setCompose(false)}
            onPublished={(result) => {
              setPublication(result);
              setCompose(false);
              setHostUin(selfUin);
              setTab('posts');
              if (!result.post)
                toast({ title: '发表已提交，暂未读回这条说说，请稍后刷新核对', tone: 'warning' });
            }}
          />
        ) : null}
      </section>
    </QzonePeopleContext.Provider>
  );
  return (
    <QzonePersonContext.Provider
      value={{
        action: personClickAction,
        spaceUin: tab === 'space' || tab === 'posts' ? currentOwner : null,
        onSpace: openSpace,
      }}
    >
      <QzoneAlbumNavigationContext.Provider
        value={(uin, topicId, name, ownerNickname) => {
          openSpace(uin, ownerNickname);
          setAlbumRequests((current) => ({
            ...current,
            [uin]: { hostUin: uin, topicId, name, revision: crypto.randomUUID() },
          }));
        }}
      >
        <QzonePublicNavigationContext.Provider value={() => setTab('public')}>
          {workspace}
        </QzonePublicNavigationContext.Provider>
        {settingsOpen && active ? (
          <Modal
            presentation="panel"
            onClose={() => setSettingsOpen(false)}
            width={480}
            labelledBy="weq-qzone-settings-title"
          >
            <header className="weq-tools-header">
              <h2 id="weq-qzone-settings-title">空间设置</h2>
              <button
                type="button"
                aria-label="关闭空间设置"
                title="关闭空间设置"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="weq-local-settings-body">
              <QzoneSettingsSection />
            </div>
          </Modal>
        ) : null}
      </QzoneAlbumNavigationContext.Provider>
    </QzonePersonContext.Provider>
  );
}

/** Each owner uses the same panes; retain data and scroll independently. */
function SpaceContent({
  active,
  refreshKey,
  selfUin,
  hostUin,
  nickname,
  albumRequest,
  publication = null,
  onSpace,
  onOwnerNickname,
}: {
  active: boolean;
  refreshKey: number;
  selfUin: string;
  hostUin: string;
  nickname: string;
  albumRequest?: QzoneAlbumRequest;
  publication?: QzonePublication | null;
  onSpace: (uin: string, nickname?: string) => void;
  onOwnerNickname: (uin: string, nickname: string) => void;
}) {
  const openProfile = useContext(QzoneProfileContext);
  const openAlbum = useContext(QzoneAlbumNavigationContext);
  const handledAlbum = useRef<string | null>(null);
  type Pane = 'home' | 'posts' | 'blogs' | 'albums' | QzoneMorePane;
  const [pane, setPane] = useState<Pane>(publication ? 'posts' : 'home');
  const [shownPublication, setShownPublication] = useState(publication);
  const [refreshes, setRefreshes] = useState<Partial<Record<Pane, number>>>(() =>
    publication ? { posts: 1 } : {},
  );
  if (publication !== shownPublication) {
    setShownPublication(publication);
    if (publication) {
      setPane('posts');
      setRefreshes((current) => ({ ...current, posts: (current.posts ?? 0) + 1 }));
    }
  }
  useMobileBack(
    active && pane === 'albums',
    () => setPane('posts'),
    40,
    () => document.querySelector<HTMLElement>('.weq-qzn-owner-space:not([hidden])'),
  );
  const [visitedAlbums, setVisitedAlbums] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  const openPane = useCallback((next: Pane) => {
    if (next === 'albums') setVisitedAlbums(true);
    setPane(next);
  }, []);
  const openHomeDestination = (next: QzoneHomeDestination) => {
    openPane(next);
    navigationRef.current
      ?.querySelector<HTMLButtonElement>(`[data-pane="${next}"]`)
      ?.focus({ preventScroll: true });
  };
  const readsEnabled = useContext(QzoneReadsEnabled);
  const indexActivity = useQQReadActivity(
    active && readsEnabled && (pane === 'home' || pane === 'blogs' || pane === 'shares'),
    { remoteCache: true },
  );
  const blogIndex = useQzoneBlogIndex({
    selfUin,
    hostUin,
    active: indexActivity.enabled && (pane === 'home' || pane === 'blogs'),
    refresh: refreshKey,
  });
  const shareIndex = useQzoneShareIndex({ selfUin, hostUin }, 0, {
    active: indexActivity.enabled && (pane === 'home' || pane === 'shares'),
    refresh: refreshKey + indexActivity.revision,
  });
  const [mediaLink, setMediaLink] = useState<{
    target: QzoneMediaDestination;
    source: Pane;
    configId: string;
    closePreview?: () => void;
  } | null>(null);
  const destination =
    active && mediaLink?.source === pane && mediaLink.configId === shareIndex.configId
      ? mediaLink.target
      : null;
  const [postAlbums, setPostAlbums] = useState<{
    configId: string;
    byPost: ReadonlyMap<string, QzoneHomeAlbumMedia>;
  }>();
  const currentPostAlbums =
    postAlbums && postAlbums.configId === shareIndex.configId ? postAlbums.byPost : undefined;
  useEffect(() => {
    if (mediaLink && !destination) setMediaLink(null);
  }, [mediaLink, destination]);
  const mediaNavigation = useMemo(
    () => ({
      previewVisible: active && !destination,
      postAlbums: currentPostAlbums,
      open: (target: QzoneMediaDestination, closePreview?: () => void) =>
        setMediaLink({ target, source: pane, configId: shareIndex.configId, closePreview }),
    }),
    [active, currentPostAlbums, destination, pane, shareIndex.configId],
  );
  const closeMediaLink = useCallback(() => setMediaLink(null), []);
  const mediaPostTitle = useId();
  const [removedTids, setRemovedTids] = usePageState(
    `deleted-posts:${selfUin}:${hostUin}`,
    [],
    pageValue.strings,
  );
  const deletedPosts = useMemo(() => new Set(removedTids), [removedTids]);
  const onDeleted = useCallback(
    (tid: string) => {
      const id = tid.toLowerCase();
      setRemovedTids((previous) =>
        previous.includes(id) ? previous : [...previous.slice(-255), id],
      );
      setRefreshes((current) => ({
        ...current,
        home: (current.home ?? 0) + 1,
        posts: (current.posts ?? 0) + 1,
      }));
    },
    [setRemovedTids],
  );
  useEffect(() => {
    if (
      !albumRequest ||
      albumRequest.hostUin !== hostUin ||
      handledAlbum.current === albumRequest.revision
    )
      return;
    handledAlbum.current = albumRequest.revision;
    openPane('albums');
  }, [albumRequest, hostUin, openPane]);
  const previousRefresh = useRef(refreshKey);
  useEffect(() => {
    if (previousRefresh.current === refreshKey) return;
    previousRefresh.current = refreshKey;
    setRefreshes((current) => ({
      ...current,
      [pane]: (current[pane] ?? 0) + 1,
      ...(pane !== 'posts' ? { posts: (current.posts ?? 0) + 1 } : {}),
    }));
  }, [refreshKey, pane]);
  const content = (
    <div className="weq-qzn-owner-space" hidden={!active}>
      <nav className="weq-qzn-owner-navigation" aria-label="空间内容" ref={navigationRef}>
        <button
          type="button"
          aria-current={pane === 'home' ? 'page' : undefined}
          onClick={() => setPane('home')}
        >
          主页
        </button>
        <button
          type="button"
          data-pane="posts"
          aria-current={pane === 'posts' ? 'page' : undefined}
          onClick={() => {
            if (pane === 'posts')
              setRefreshes((current) => ({ ...current, posts: (current.posts ?? 0) + 1 }));
            else setPane('posts');
          }}
        >
          说说
        </button>
        <button
          type="button"
          data-pane="blogs"
          aria-current={pane === 'blogs' ? 'page' : undefined}
          onClick={() => setPane('blogs')}
        >
          日志
        </button>
        <button
          type="button"
          data-pane="albums"
          aria-current={pane === 'albums' ? 'page' : undefined}
          onClick={() => openPane('albums')}
        >
          相册
        </button>
        {(Object.keys(moreSpacePanes) as QzoneMorePane[]).map((key) => (
          <button
            key={key}
            type="button"
            data-pane={key}
            aria-current={pane === key ? 'page' : undefined}
            onClick={() => setPane(key)}
          >
            {moreSpacePanes[key]}
          </button>
        ))}
        {openProfile ? (
          <div className="weq-qzn-owner-profile">
            <QzonePersonIdentity uin={hostUin} nickname={nickname} onSpace={onSpace} size={24} />
          </div>
        ) : null}
      </nav>
      <QzonePage active={active && pane === 'home'} refreshKey={refreshes.home ?? 0}>
        <QzoneSpaceHome
          key={`${selfUin}:${hostUin}:${refreshes.home}`}
          selfUin={selfUin}
          hostUin={hostUin}
          onSpace={onSpace}
          PostCard={HomePost}
          blogIndex={blogIndex}
          shareIndex={shareIndex}
          nickname={nickname}
          onOwnerNickname={onOwnerNickname}
          onOpenPane={openHomeDestination}
          deletedPosts={deletedPosts}
          onPostAlbums={setPostAlbums}
          onDeleted={onDeleted}
        />
      </QzonePage>
      <QzonePage
        active={active && pane === 'posts'}
        refreshKey={refreshes.posts ?? 0}
        resetScrollKey={publication?.tid}
        retainTimeline
      >
        <div className="weq-qzn-timeline">
          <Posts
            selfUin={selfUin}
            hostUin={hostUin}
            nickname={nickname}
            onSpace={onSpace}
            onOwnerNickname={onOwnerNickname}
            publishedPost={publication?.post}
            deletedPosts={deletedPosts}
            onDeleted={onDeleted}
          />
        </div>
      </QzonePage>
      <QzonePage active={active && pane === 'blogs'} refreshKey={refreshes.blogs ?? 0}>
        <QzoneBlogs key={hostUin} index={blogIndex} nickname={nickname} onSpace={onSpace} />
      </QzonePage>
      {(Object.keys(moreSpacePanes) as QzoneMorePane[]).map((key) => (
        <QzonePage key={key} active={active && pane === key} refreshKey={refreshes[key] ?? 0}>
          <QzoneMore
            pane={key}
            shareIndex={shareIndex}
            selfUin={selfUin}
            hostUin={hostUin}
            nickname={nickname}
            onSpace={onSpace}
          />
        </QzonePage>
      ))}
      {visitedAlbums ? (
        <QzonePage
          active={active && pane === 'albums'}
          refreshKey={refreshes.albums ?? 0}
          pauseReadsDuringNavigation={false}
        >
          <QzoneAlbums
            selfUin={selfUin}
            hostUin={hostUin}
            albumRequest={albumRequest}
            onClose={() => setPane('posts')}
          />
        </QzonePage>
      ) : null}
      {destination ? (
        <QzoneMediaNavigationContext.Provider value={null}>
          {destination.kind === 'album' ? (
            <QzoneAlbumDestination
              selfUin={selfUin}
              target={destination}
              onClose={closeMediaLink}
              onJumpToAlbum={(name) => {
                mediaLink?.closePreview?.();
                closeMediaLink();
                openAlbum?.(
                  destination.hostUin,
                  destination.topicId,
                  name,
                  destination.hostUin === hostUin ? nickname : undefined,
                );
              }}
            />
          ) : (
            <Modal
              presentation="panel"
              width={640}
              onClose={closeMediaLink}
              labelledBy={mediaPostTitle}
              focusContainerOnOpen
            >
              <header className="weq-tools-header">
                <h2 id={mediaPostTitle}>原说说</h2>
                <button
                  type="button"
                  className="weq-compose-x"
                  onClick={closeMediaLink}
                  aria-label="返回视频"
                  title="返回视频"
                >
                  <ArrowLeft size={17} aria-hidden />
                </button>
              </header>
              <QzonePage active={active} refreshKey={0}>
                <div className="weq-qzn-timeline">
                  <LinkedPost
                    selfUin={selfUin}
                    hostUin={destination.hostUin}
                    tid={destination.tid}
                    nickname={nickname}
                    onSpace={onSpace}
                  />
                </div>
              </QzonePage>
            </Modal>
          )}
        </QzoneMediaNavigationContext.Provider>
      ) : null}
    </div>
  );
  return (
    <QzoneMediaNavigationContext.Provider value={mediaNavigation}>
      {content}
    </QzoneMediaNavigationContext.Provider>
  );
}

function LinkedPost({
  selfUin,
  hostUin,
  tid,
  nickname,
  onSpace,
  focusComment,
}: {
  selfUin: string;
  hostUin: string;
  tid: string;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
  focusComment?: RelatedComment;
}) {
  const { active } = useContext(QzonePageContext);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: active });
  const configId = config.data?.uin === selfUin ? config.data.configId : '';
  const { query } = useQzonePostDetail(selfUin, hostUin, tid, configId ?? '', active, false);
  const post = query.data;
  const error = config.error ?? query.error;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'start' });
  }, [active, tid]);
  return (
    <div ref={ref} className="weq-qzn-linked-post">
      {post ? (
        <Post
          selfUin={selfUin}
          hostUin={hostUin}
          nickname={nickname}
          post={post}
          focusComment={focusComment}
          onSpace={onSpace}
        />
      ) : error ? (
        <p role="alert">
          {error instanceof Error ? error.message : '读取说说失败。'}
          <button
            type="button"
            onClick={() => void (configId ? query.refetch() : config.refetch())}
            className="weq-retry-button"
          >
            <RefreshCw size={14} aria-hidden />
            重试
          </button>
        </p>
      ) : (
        <p role="status">正在读取说说…</p>
      )}
    </div>
  );
}

function QzoneAlbums({
  selfUin,
  hostUin,
  albumRequest,
  onClose,
}: {
  selfUin: string;
  hostUin: string;
  albumRequest?: QzoneAlbumRequest;
  onClose: () => void;
}) {
  const { active, refresh } = useContext(QzonePageContext);
  return (
    <QzoneAlbumDialog
      selfUin={selfUin}
      open
      embedded
      active={active}
      refreshKey={refresh}
      hostUin={hostUin}
      albumTarget={albumRequest}
      onClose={onClose}
    />
  );
}

interface PostsSnapshot {
  posts: QzoneEmotion[];
  nextOffset: number;
  done: boolean;
  pages: number[];
  bridge: { offset: number; done: boolean; indices: [string, number][] } | null;
}

const noDeletedPosts: ReadonlySet<string> = new Set();

function Posts({
  selfUin,
  hostUin,
  nickname,
  onSpace,
  onOwnerNickname,
  publishedPost,
  deletedPosts = noDeletedPosts,
  onDeleted,
}: {
  selfUin: string;
  hostUin: string;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
  onOwnerNickname: (uin: string, nickname: string) => void;
  publishedPost?: QzoneEmotion | null;
  deletedPosts?: ReadonlySet<string>;
  onDeleted?: (tid: string) => void;
}) {
  const { active, refresh } = useContext(QzonePageContext);
  const dataCache = usePageDataCache();
  const cacheKey = JSON.stringify(['posts', selfUin, hostUin]);
  const [cached] = useState(() => dataCache.read<PostsSnapshot>(cacheKey));
  const lastRefresh = useRef(refresh);
  const [posts, setPosts] = useState<QzoneEmotion[]>(cached?.posts ?? []);
  const visiblePosts = useMemo(
    () => posts.filter((post) => !deletedPosts.has(post.tid.toLowerCase())),
    [posts, deletedPosts],
  );
  const selection = useContentMultiSelect({ kind: 'qzone-posts', container: hostUin }, active);
  const multi = useMultiSelection({
    ids: visiblePosts.map((post) => post.tid),
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    anchorRef: selection.anchorRef,
    enabled: selection.selectionMode,
    disabled: !active,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
  });
  const [offset, setOffset] = useState(0);
  const lastOffset = useRef(offset);
  const headRequest = useRef(Boolean(cached));
  const [pageRequest, setPageRequest] = useState(0);
  const loadOffset = useCallback((value: number) => {
    headRequest.current = false;
    setOffset(value);
    setPageRequest((current) => current + 1);
  }, []);
  const nextOffset = useRef(cached?.nextOffset ?? 0);
  const currentPosts = useRef<QzoneEmotion[]>(cached?.posts ?? []);
  const fetchedPages = useRef(new Set<number>(cached?.pages));
  const bridgeTail = useRef<{ offset: number; done: boolean; indices: Map<string, number> } | null>(
    cached?.bridge ? { ...cached.bridge, indices: new Map(cached.bridge.indices) } : null,
  );
  const [done, setDone] = useState(cached?.done ?? false);
  const doneRef = useRef(done);
  doneRef.current = done;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const settledRequest = useRef(cached && refresh === 0 ? '0:0:0' : null);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    if (!publishedPost) return;
    const updated = mergeQzonePosts(currentPosts.current, [publishedPost]).sort(
      (a, b) => b.time - a.time,
    );
    currentPosts.current = updated;
    setPosts(updated);
  }, [publishedPost]);
  useEffect(() => {
    if (!fetchedPages.current.size) return;
    const bridge = bridgeTail.current;
    dataCache.write(cacheKey, {
      posts: visiblePosts,
      nextOffset: nextOffset.current,
      done,
      pages: [...fetchedPages.current],
      bridge: bridge ? { ...bridge, indices: [...bridge.indices] } : null,
    } satisfies PostsSnapshot);
  }, [visiblePosts, done, cacheKey, dataCache]);
  useEffect(() => {
    const request = `${refresh}:${pageRequest}:${retry}`;
    if (!active || settledRequest.current === request) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError('');
    if (refresh !== lastRefresh.current) headRequest.current = true;
    else if (offset !== lastOffset.current) headRequest.current = false;
    lastRefresh.current = refresh;
    lastOffset.current = offset;
    const refreshing = headRequest.current;
    const pageOffset = refreshing ? 0 : offset;
    void run((requestId) =>
      client.account.qzone.posts.query({ selfUin, hostUin, requestId, offset: pageOffset }),
    )
      .then((page) => {
        if (!live) return;
        fetchedPages.current.add(pageOffset);
        if (page.nickname) onOwnerNickname(hostUin, page.nickname);
        const previous = currentPosts.current;
        const hadPosts = previous.length > 0;
        const previousIds = new Set(previous.map((post) => post.tid));
        const merged = mergeQzonePosts(previous, page.list, pageOffset === 0).sort(
          (a, b) => b.time - a.time,
        );
        const overlaps = page.list.some((post) => previousIds.has(post.tid));
        if (
          refreshing &&
          hadPosts &&
          !overlaps &&
          page.list.length &&
          page.list.length < page.total
        ) {
          // If more than a page arrived while away, bridge that gap before resuming the old tail.
          bridgeTail.current ??= {
            offset: nextOffset.current,
            done: doneRef.current,
            indices: new Map(previous.map((post, index) => [post.tid, index])),
          };
          nextOffset.current = page.list.length;
          setDone(false);
        } else if (!refreshing || !hadPosts) {
          const tail = bridgeTail.current;
          const overlap = tail ? page.list.findIndex((post) => tail.indices.has(post.tid)) : -1;
          if (tail && overlap >= 0) {
            const shift = pageOffset + overlap - tail.indices.get(page.list[overlap]!.tid)!;
            nextOffset.current = Math.max(pageOffset + page.list.length, tail.offset + shift);
            setDone(tail.done);
            bridgeTail.current = null;
          } else {
            const reachedEnd = !page.list.length || pageOffset + page.list.length >= page.total;
            setDone(reachedEnd || merged.length === previous.length);
            nextOffset.current = pageOffset + page.list.length;
            if (reachedEnd) bridgeTail.current = null;
          }
        }
        currentPosts.current = merged;
        setPosts(merged);
      })
      .catch((error: unknown) => {
        if (live) setError(errorText(error));
      })
      .finally(() => {
        if (live) {
          settledRequest.current = request;
          setLoading(false);
        }
      });
    return () => {
      live = false;
      cancel();
    };
  }, [active, selfUin, hostUin, offset, pageRequest, retry, refresh, run, cancel, onOwnerNickname]);
  const pageCountLabel = `（已获取 ${fetchedPages.current.size} 页）`;
  return (
    <div {...multi.rootProps}>
      {loading && posts.length > 0 && headRequest.current ? (
        <LoadingStatus text={`正在刷新…${pageCountLabel}`} />
      ) : null}
      {visiblePosts.map((post) => (
        <Post
          key={post.tid}
          selfUin={selfUin}
          hostUin={hostUin}
          nickname={nickname}
          post={post}
          onDeleted={
            onDeleted
              ? () => {
                  if (selection.selectedIds.has(post.tid))
                    selection.setSelectedIds(
                      (ids) => new Set([...ids].filter((id) => id !== post.tid)),
                    );
                  onDeleted(post.tid);
                }
              : undefined
          }
          selectionProps={multi.itemProps(post.tid)}
          selected={selection.selectedIds.has(post.tid)}
          onSpace={onSpace}
        />
      ))}
      {error || !visiblePosts.length ? (
        <State
          loading={loading}
          error={error}
          empty={done || !posts.length ? '这个空间暂无可查看的说说' : ''}
          progress={pageCountLabel}
          retry={() => setRetry((value) => value + 1)}
        />
      ) : null}
      {posts.length > 0 && !done && !error ? (
        <QzoneAutoPage
          key={nextOffset.current}
          loading={loading}
          onNext={() => loadOffset(nextOffset.current)}
        />
      ) : null}
      <div className="weq-qzn-page-sentinel">
        {done && posts.length > 0 ? (
          <p className="weq-qzn-status">
            已到列表末尾<NumericText>{pageCountLabel}</NumericText>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CompletionStatus({
  loading,
  error,
  retry,
  original = false,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
  original?: boolean;
}) {
  if (!loading && !error) return null;
  return (
    <div className="weq-qzn-completion" role="status">
      {loading ? (
        <>
          <Loader2 size={13} className="weq-spin" />
          {original ? '正在补全转发原文…' : '正在补全说说…'}
        </>
      ) : (
        <>
          <span>{error}</span>
          <button
            type="button"
            title="重试补全"
            aria-label={original ? '重试补全转发原文' : '重试补全说说'}
            onClick={retry}
          >
            <RefreshCw size={13} />
          </button>
        </>
      )}
    </div>
  );
}

function useQzonePostDetail(
  selfUin: string,
  hostUin: string,
  tid: string,
  configId: string,
  enabled: boolean,
  background: boolean,
) {
  const { run } = useQzoneRequests();
  const queryKey = useMemo(
    () => ['qzone-home-post', configId, { selfUin, hostUin, tid }] as const,
    [configId, selfUin, hostUin, tid],
  );
  const query = useQuery({
    queryKey,
    enabled: enabled && Boolean(configId),
    refetchOnMount: true,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ queryKey: [, expectedAccountConfigId, input], signal }) => {
      const value = await run(
        (requestId) =>
          client.account.qzone.detail.query({ ...input, requestId, expectedAccountConfigId }),
        background,
        signal,
      );
      if (value.post?.tid !== input.tid) throw new Error('这条说说不存在或无权查看。');
      return value.post;
    },
  });
  return { queryKey, query };
}

function HomePost({
  feed,
  tid,
  album,
  selfUin,
  configId,
  available,
  onSpace,
  onDeleted,
  selectionProps,
  selected,
}: QzoneHomePostProps) {
  const hostUin = feed.author.uin;
  const ref = useRef<HTMLElement>(null);
  const visible = useNearViewport(ref, false, available);
  const queryClient = useQueryClient();
  const {
    queryKey,
    query: { data: detail, isError, refetch },
  } = useQzonePostDetail(selfUin, hostUin, tid, configId, visible, true);
  const wasVisible = useRef(false);
  useEffect(() => {
    if (!visible && wasVisible.current) void queryClient.cancelQueries({ queryKey, exact: true });
    wasVisible.current = visible;
  }, [visible, queryClient, queryKey]);
  const preview = useMemo(() => qzoneHomePostPreview(feed, tid), [feed, tid]);
  const post = useMemo(
    () => (detail ? mergeQzoneHomePost(preview, detail) : preview),
    [preview, detail],
  );
  return (
    <Post
      selfUin={selfUin}
      hostUin={hostUin}
      nickname={feed.author.nick || hostUin}
      portrait={feed.author.portrait}
      post={post}
      album={album}
      onSpace={onSpace}
      onDeleted={() => onDeleted(tid)}
      articleRef={ref}
      initialLikeCount={feed.likeCount}
      initialViewCount={feed.viewCount}
      selectionProps={selectionProps}
      selected={selected}
      previewStatus={
        isError && !detail && available ? (
          <CompletionStatus
            loading={false}
            error="未能补全说说，已保留主页预览"
            retry={() => void refetch()}
          />
        ) : null
      }
    />
  );
}

const idlePostCompletion = { post: false, repost: false };
const emptyPostCompletionError = { post: '', repost: '' };

function missingPostImages(source: QzoneEmotion, current: QzoneEmotion, scope: 'post' | 'repost') {
  const images = scope === 'repost' ? current.repost?.images : current.images;
  return (
    source.imageTotal != null &&
    source.imageTotal > Math.max(source.imageReturned ?? 0, images?.length ?? 0)
  );
}

function Post({
  selfUin,
  hostUin,
  nickname,
  post: sourcePost,
  onSpace,
  articleRef,
  sourceName = null,
  links = [],
  focusComment,
  readComments,
  onDeleted,
  portrait,
  initialLikeCount,
  initialViewCount,
  previewStatus,
  album,
  selectionProps,
  selected = false,
}: {
  selfUin: string;
  hostUin: string;
  nickname: string;
  post: QzoneEmotion;
  onSpace: (uin: string, nickname?: string) => void;
  articleRef?: RefObject<HTMLElement | null>;
  sourceName?: string | null;
  links?: ReturnType<typeof projectQzoneFeed>['links'];
  focusComment?: RelatedComment | null;
  readComments?: () => Promise<QzoneInteraction>;
  onDeleted?: () => void;
  portrait?: string;
  initialLikeCount?: number | null;
  initialViewCount?: number | null;
  previewStatus?: ReactNode;
  album?: QzoneHomeAlbumMedia;
  selectionProps?: MultiSelectionItemProps;
  selected?: boolean;
}) {
  const localRef = useRef<HTMLElement>(null);
  const ref = articleRef ?? localRef;
  const imageScope = sourcePost.imageTotal == null ? 'post' : qzoneImageCompletionScope(sourcePost);
  const needsCompletion = Boolean(
    sourcePost.contentTruncated ||
      sourcePost.repost?.contentTruncated ||
      missingPostImages(sourcePost, sourcePost, imageScope),
  );
  const visible = useNearViewport(ref, false, needsCompletion);
  const { refresh } = useContext(QzonePageContext);
  const readsPaused = useContext(QzoneReadPauseContext);
  const { run, cancel } = useQzoneRequests();
  const sourceSignature = useMemo(() => JSON.stringify(sourcePost), [sourcePost]);
  const cardData = useContext(FeedCardData);
  const completionKey = `post:${selfUin}:${hostUin}:${sourcePost.tid}:${refresh}`;
  const [completed, setCompleted] = useState<{ signature: string; post: QzoneEmotion } | null>(
    () => cardData?.get<{ signature: string; post: QzoneEmotion }>(completionKey) ?? null,
  );
  const completedRef = useRef(completed);
  completedRef.current = completed;
  const post = completed?.signature === sourceSignature ? completed.post : sourcePost;
  const [completing, setCompleting] = useState(idlePostCompletion);
  const [completionError, setCompletionError] = useState(emptyPostCompletionError);
  const [retry, setRetry] = useState(0);
  const attempted = useRef('');
  useEffect(() => {
    if (readsPaused) {
      setCompleting(idlePostCompletion);
      return undefined;
    }
    const attempt = `${sourceSignature}:${refresh}:${retry}`;
    const observed =
      completedRef.current?.signature === sourceSignature ? completedRef.current.post : sourcePost;
    const ownTextNeeded = observed.contentTruncated === true;
    const originalTextNeeded = observed.repost?.contentTruncated === true;
    const textNeeded = ownTextNeeded || originalTextNeeded;
    const imagesNeeded = missingPostImages(sourcePost, observed, imageScope);
    if (!textNeeded && !imagesNeeded) {
      setCompleting(idlePostCompletion);
      setCompletionError(emptyPostCompletionError);
    }
    if (!visible || (!textNeeded && !imagesNeeded) || attempted.current === attempt)
      return undefined;
    attempted.current = attempt;
    let live = true;
    let settled = false;
    setCompleting({
      post: ownTextNeeded || (imagesNeeded && imageScope === 'post'),
      repost: originalTextNeeded || (imagesNeeded && imageScope === 'repost'),
    });
    setCompletionError(emptyPostCompletionError);
    const input = { selfUin, hostUin, tid: sourcePost.tid };
    void (async () => {
      let next = {
        ...(completedRef.current?.signature === sourceSignature
          ? completedRef.current.post
          : sourcePost),
      };
      const issues: { post: string[]; repost: string[] } = { post: [], repost: [] };
      if (textNeeded) {
        const result = await completeQzonePostText(
          next,
          () =>
            run(
              (requestId) =>
                client.account.qzone.detail.query({
                  ...input,
                  time: ownTextNeeded && sourcePost.time > 0 ? sourcePost.time : undefined,
                  requestId,
                }),
              true,
            ),
          (partial) => {
            if (!live) return;
            completedRef.current = { signature: sourceSignature, post: partial };
            setCompleted(completedRef.current);
          },
          () => live,
        );
        if (!live) return;
        next = result.post;
        if (result.issue) {
          const own = result.post.contentTruncated === true;
          const original = result.post.repost?.contentTruncated === true;
          if (own) issues.post.push(result.issue);
          if (original) issues.repost.push(result.issue);
          if (!own && !original)
            issues[originalTextNeeded && !ownTextNeeded ? 'repost' : 'post'].push(result.issue);
        }
      }
      if (imagesNeeded) {
        try {
          const imageInput =
            imageScope === 'repost'
              ? { selfUin, hostUin: next.repost?.uin || '', tid: next.repost?.tid || '' }
              : input;
          if (
            !/^[1-9]\d{4,19}$/.test(imageInput.hostUin) ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(imageInput.tid) ||
            imageInput.tid === '0'
          )
            throw new Error('原说说定位信息不完整');
          const urls = await run(
            (requestId) => client.account.qzone.images.query({ ...imageInput, requestId }),
            true,
          );
          if (!live) return;
          const current = imageScope === 'repost' ? (next.repost?.images ?? []) : next.images;
          const images = mergeQzonePostImages(current, urls);
          if (imageScope === 'repost' && next.repost) {
            next.repost = { ...next.repost, images };
            next.images = [];
          } else next.images = images;
          if (images.length < (sourcePost.imageTotal ?? 0))
            issues[imageScope].push('仍有图片未补全');
        } catch {
          if (!live) return;
          issues[imageScope].push('图片补全失败');
        }
      }
      if (!live) return;
      settled = true;
      completedRef.current = { signature: sourceSignature, post: next };
      if (!issues.post.length && !issues.repost.length)
        cardData?.put(completionKey, completedRef.current);
      setCompleted(completedRef.current);
      setCompletionError({ post: issues.post.join(' · '), repost: issues.repost.join(' · ') });
      setCompleting(idlePostCompletion);
    })();
    return () => {
      live = false;
      if (!settled) attempted.current = '';
      cancel();
    };
  }, [
    readsPaused,
    visible,
    imageScope,
    sourceSignature,
    sourcePost,
    cardData,
    completionKey,
    selfUin,
    hostUin,
    refresh,
    retry,
    run,
    cancel,
  ]);
  const images = post.repost
    ? post.images.filter((url) => !post.repost!.images.includes(url))
    : post.images;
  const videos = post.repost
    ? post.videos.filter(
        (video) =>
          !post.repost!.videos.some(
            (original) =>
              (video.videoId && original.videoId === video.videoId) ||
              (video.videoUrl && original.videoUrl === video.videoUrl),
          ),
      )
    : post.videos;
  const render = ({ tag, menu, actions }: PostActionSlots) => (
    <>
      <div className="weq-qzn-post-head">
        <QzonePersonHeader
          uin={hostUin}
          nickname={nickname}
          url={portrait}
          onSpace={onSpace}
          size={34}
          time={
            <div className="weq-qzn-post-meta">
              <QzoneTime value={post.time} />
              {post.isPrivate ? (
                <span className="weq-qzn-post-status">
                  <Lock size={16} className="weq-qzn-post-status-icon" aria-hidden />
                  <span>仅自己可见</span>
                </span>
              ) : null}
              {tag}
            </div>
          }
        />
        {menu ? <div className="weq-qzn-post-tools">{menu}</div> : null}
      </div>
      {post.content.trim() ? (
        <p className="weq-qzn-content" data-privacy-sensitive>
          <QzoneText content={post.content} onSpace={onSpace} />
        </p>
      ) : null}
      {previewStatus}
      <CompletionStatus
        loading={completing.post}
        error={completionError.post}
        retry={() => setRetry((v) => v + 1)}
      />
      <QzoneMediaGrid
        images={images.filter((url) => !links.some((link) => link.cover === url))}
        videos={videos}
        target={{ selfUin, hostUin, tid: post.tid, time: post.time }}
        album={post.repost ? undefined : album}
        allowPostAlbum={!post.repost}
      />
      <QzoneFeedLinks links={links} ownerUin={hostUin} ownerNickname={nickname} />
      {post.repost ? (
        <Repost
          selfUin={selfUin}
          original={post.repost}
          onSpace={onSpace}
          completion={{
            loading: completing.repost,
            error: completionError.repost,
            retry: () => setRetry((v) => v + 1),
          }}
        />
      ) : null}
      {sourceName ? <p className="weq-qzn-source">来自 {sourceName}</p> : null}
      {actions}
    </>
  );
  return (
    <article
      ref={ref}
      {...selectionProps}
      data-qzone-tid={post.tid}
      className={`weq-qzn-post${selected ? ' is-selected' : ''}`}
    >
      <PostActions
        key={`${hostUin}:${post.tid}`}
        selfUin={selfUin}
        hostUin={hostUin}
        post={post}
        onSpace={onSpace}
        focusComment={focusComment}
        readComments={readComments}
        onDeleted={onDeleted}
        initialLikeCount={initialLikeCount}
        initialViewCount={initialViewCount}
        render={render}
      />
    </article>
  );
}

function Repost({
  selfUin,
  original,
  onSpace,
  completion,
}: {
  selfUin: string;
  original: NonNullable<QzoneEmotion['repost']> & {
    time?: number;
    commentNum?: number | null;
    likeCount?: number | null;
  };
  onSpace: (uin: string, nickname?: string) => void;
  completion?: { loading: boolean; error: string; retry: () => void };
}) {
  const validUin = /^[1-9]\d{4,19}$/.test(original.uin);
  const render = ({ tag, menu, actions }: PostActionSlots) => (
    <>
      <div className="weq-qzn-repost-author">
        <QzonePersonHeader
          size={26}
          uin={validUin ? original.uin : null}
          nickname={original.nickname || original.uin || '原作者'}
          onSpace={onSpace}
          time={
            <div className="weq-qzn-post-meta">
              <QzoneTime value={original.time || original.timeLabel} />
              {tag}
            </div>
          }
        />
        {menu ? <div className="weq-qzn-post-tools">{menu}</div> : null}
      </div>
      {original.content.trim() ? (
        <p className="weq-qzn-content">
          <QzoneText content={original.content} onSpace={onSpace} />
        </p>
      ) : null}
      {completion ? <CompletionStatus {...completion} original /> : null}
      <QzoneMediaGrid
        images={original.images}
        videos={original.videos}
        target={{ selfUin, hostUin: original.uin, tid: original.tid, time: original.time ?? 0 }}
      />
      {actions ?? (
        <QzoneActionsRow>
          <span>
            <ThumbsUp size={16} />
            <span className="weq-qzn-action-label">点赞</span> <span className="weq-number">?</span>
          </span>
          <span>
            <MessageCircle size={16} />
            <span className="weq-qzn-action-label">评论</span> <span className="weq-number">?</span>
          </span>
          <span>
            <Repeat2 size={16} />
            <span className="weq-qzn-action-label">转发</span> <span className="weq-number">?</span>
          </span>
          <span className="weq-qzn-views">
            <Eye size={16} />
            <span className="weq-qzn-action-label">浏览量</span>{' '}
            <span className="weq-number">?</span>
          </span>
        </QzoneActionsRow>
      )}
    </>
  );
  return (
    <section className="weq-qzn-repost" aria-label="原帖">
      {validUin && /^[a-zA-Z0-9_-]{1,128}$/.test(original.tid) ? (
        <PostActions
          key={`${original.uin}:${original.tid}`}
          selfUin={selfUin}
          hostUin={original.uin}
          post={{
            tid: original.tid,
            time: original.time ?? 0,
            commentNum: original.commentNum ?? null,
            content: original.content,
            images: original.images,
            videos: original.videos,
          }}
          initialLikeCount={original.likeCount ?? null}
          onSpace={onSpace}
          render={render}
        />
      ) : (
        render({ tag: null, menu: null, actions: null })
      )}
    </section>
  );
}

type InteractionPost = Pick<QzoneEmotion, 'tid' | 'time'> & {
  commentNum: number | null;
  content?: string;
  images?: string[];
  videos?: QzoneEmotion['videos'];
  forwardNum?: number;
  repost?: QzoneEmotion['repost'];
};
type PostActionSlots = { tag: ReactNode; menu: ReactNode; actions: ReactNode };
const PostActions = withQQAccountScope(PostActionsBody, (props) => ({
  kind: 'qzone',
  target: { kind: 'post', uin: props.hostUin, tid: props.post.tid },
}));
function PostActionsBody({
  selfUin,
  hostUin,
  post,
  onSpace,
  initialLikeCount = null,
  initialViewCount = null,
  focusComment,
  readComments,
  onDeleted,
  render,
}: {
  selfUin: string;
  hostUin: string;
  post: InteractionPost;
  onSpace: (uin: string, nickname?: string) => void;
  initialLikeCount?: number | null;
  initialViewCount?: number | null;
  focusComment?: RelatedComment | null;
  readComments?: () => Promise<QzoneInteraction>;
  onDeleted?: () => void;
  render: (slots: PostActionSlots) => ReactElement;
}) {
  const [expanded, setExpanded] = useState<'comments' | 'likes' | null>(
    focusComment ? 'comments' : null,
  );
  const [forwardOpen, setForwardOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<QzoneReplyTarget | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentPicture, setCommentPicture] = useState<{ path: string; fileName: string } | null>(
    null,
  );
  const focusId = focusComment?.id;
  const focusUin = focusComment?.uin;
  useEffect(() => {
    if (focusId && focusUin) setExpanded('comments');
  }, [focusId, focusUin]);
  useEffect(() => {
    if (expanded === 'comments')
      ref.current?.querySelector<HTMLInputElement>('[aria-label="说说评论"]')?.focus();
  }, [expanded]);
  const [likes, setLikes] = useState<QzoneLikesResult | null>(null);
  const [likeError, setLikeError] = useState('');
  const [loading, setLoading] = useState(false);
  const { refresh } = useContext(QzonePageContext);
  const cardData = useContext(FeedCardData);
  const summaryKey = `summary:${selfUin}:${hostUin}:${post.tid}:${refresh}`;
  const forwardKey = `forwards:${selfUin}:${hostUin}:${post.tid}:${refresh}`;
  const summaryRefresh = useRef<number | null>(null);
  const summaryGeneration = useRef(0);
  const [writeRevision, setWriteRevision] = useState(0);
  const [commentReadback, setCommentReadback] = useState<{
    revision: number;
    refresh: number;
    page: QzoneInteraction;
  } | null>(null);
  const [likeRevision, setLikeRevision] = useState(0);
  const [likeChange, setLikeChange] = useState<{
    write: QzoneLikeChange;
    count: number | null;
  } | null>(null);
  const previousLikeChange = useRef(likeChange);
  const likePending = likeChange?.write.pending === true;
  const pinCard = useContext(PinFeedCard);
  const interacting = Boolean(
    expanded || forwardOpen || commentDraft || commentPicture || likePending,
  );
  useLayoutEffect(() => {
    if (!pinCard || !interacting) return;
    pinCard(true);
    return () => pinCard(false);
  }, [interacting, pinCard]);
  const readsPaused = useContext(QzoneReadPauseContext);
  const [commentCount, setCommentCount] = useState(post.commentNum);
  useEffect(() => {
    if (post.commentNum !== null) setCommentCount(post.commentNum);
  }, [post.commentNum]);
  const ref = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(ref, true);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    if (readsPaused || !visible || likePending || summaryRefresh.current === refresh)
      return undefined;
    type Summary = Awaited<ReturnType<typeof client.account.qzone.summary.query>>;
    const apply = (result: Summary) => {
      summaryRefresh.current = refresh;
      if (result.likes) {
        setLikes(result.likes);
        setLikeChange(null);
        previousLikeChange.current = null;
        setLikeRevision((value) => value + 1);
      }
      if (result.commentCount !== null) setCommentCount(result.commentCount);
      setLikeError(
        result.likes && (result.commentCount !== null || writeRevision === 0)
          ? ''
          : '互动数据不完整，请重试。',
      );
    };
    const cached = writeRevision === 0 ? cardData?.get<Summary>(summaryKey) : undefined;
    if (cached) {
      apply(cached);
      setLoading(false);
      return;
    }
    let live = true;
    const generation = ++summaryGeneration.current;
    const current = () => live && generation === summaryGeneration.current;
    setLoading(true);
    void run(
      (requestId) =>
        client.account.qzone.summary.query({
          selfUin,
          hostUin,
          tid: post.tid,
          requestId,
          needCommentCount: post.commentNum === null || writeRevision > 0,
        }),
      true,
    )
      .then((result) => {
        if (current()) {
          apply(result);
          if (result.likes && (result.commentCount !== null || writeRevision === 0))
            cardData?.put(summaryKey, result);
        }
      })
      .catch((error: unknown) => {
        if (current()) setLikeError(errorText(error));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      live = false;
      cancel();
    };
  }, [
    readsPaused,
    visible,
    selfUin,
    hostUin,
    post.tid,
    post.commentNum,
    refresh,
    cardData,
    summaryKey,
    run,
    cancel,
    writeRevision,
    likePending,
  ]);
  const remoteLikeCount = likes?.reportedTotal ?? initialLikeCount;
  const likeCount = likeChange ? likeChange.count : remoteLikeCount;
  const composer = (
    <QzoneWriteActions
      key={`${hostUin}:${post.tid}`}
      hostUin={hostUin}
      tid={post.tid}
      time={post.time}
      draftContent={commentDraft}
      onDraftContentChange={setCommentDraft}
      draftPicture={commentPicture}
      onDraftPictureChange={setCommentPicture}
      replyTarget={replyTarget}
      onCancelReply={() => setReplyTarget(null)}
      onCommentAccepted={() => {
        if (!replyTarget) setCommentCount((count) => (count === null ? null : count + 1));
      }}
      onCommentsReadback={(page) =>
        setCommentReadback({ revision: writeRevision + 1, refresh, page })
      }
      onChanged={() => {
        cardData?.delete(summaryKey);
        summaryGeneration.current++;
        summaryRefresh.current = null;
        setWriteRevision((value) => value + 1);
      }}
    />
  );
  const renderActions = (upvote: ReactNode) => (
    <div ref={ref}>
      <QzoneActionsRow>
        <QzoneLikesPopover
          trigger={
            <QzoneWriteActions
              mode="like"
              hostUin={hostUin}
              tid={post.tid}
              time={post.time}
              likeCount={likeCount}
              initialLiked={qzoneSelfLiked(likes, selfUin)}
              likeRevision={likeRevision}
              onLikeChange={(change) => {
                cardData?.delete(summaryKey);
                summaryGeneration.current++;
                summaryRefresh.current = null;
                if (change?.pending) {
                  previousLikeChange.current = likeChange;
                  const delta =
                    change.previous === null ? 0 : Number(change.next) - Number(change.previous);
                  setLikeChange({
                    write: change,
                    count: likeCount === null ? null : Math.max(0, likeCount + delta),
                  });
                } else if (change)
                  setLikeChange((current) => (current ? { ...current, write: change } : null));
                else setLikeChange(previousLikeChange.current);
              }}
              onChanged={() => {
                cardData?.delete(summaryKey);
                summaryGeneration.current++;
                summaryRefresh.current = null;
                setWriteRevision((value) => value + 1);
              }}
            />
          }
        >
          <Interaction
            mode="likes"
            selfUin={selfUin}
            hostUin={hostUin}
            post={post}
            onSpace={onSpace}
            initialLikes={likes}
            onCommentCount={setCommentCount}
            writePending={likePending}
          />
        </QzoneLikesPopover>
        <QzoneCommentToggle
          expanded={expanded === 'comments'}
          count={commentCount}
          onToggle={() => setExpanded(expanded === 'comments' ? null : 'comments')}
        />
        <QzoneForwardAction
          key={`${selfUin}:${hostUin}:${post.tid}:${refresh}`}
          onClick={() => setForwardOpen(true)}
          target={{ selfUin, hostUin, tid: post.tid }}
          autoRead={visible}
          cache={cardData}
          cacheKey={forwardKey}
          onSpace={onSpace}
          paused={readsPaused}
          renderContent={(content) => <QzoneText content={content} onSpace={onSpace} />}
        />
        {upvote}
        {loading ? <Loader2 size={13} className="weq-spin" aria-label="正在加载互动数据" /> : null}
        {likeError && (
          <button
            type="button"
            title="重试互动数据校准"
            aria-label="重试互动数据校准"
            onClick={() => {
              cardData?.delete(summaryKey);
              summaryRefresh.current = null;
              setWriteRevision((value) => value + 1);
            }}
          >
            <RefreshCw size={14} />
          </button>
        )}
        <span className="weq-qzn-views" title="浏览量（非去重访客数）">
          <Eye size={16} />
          <span className="weq-qzn-action-label">浏览量</span>{' '}
          <span className="weq-number">{likes?.reportedViewCount ?? initialViewCount ?? '?'}</span>
        </span>
      </QzoneActionsRow>
      {likeError && (
        <p className="weq-qzn-status" role="status">
          互动数据暂未校准：{likeError}
        </p>
      )}
      {expanded === 'comments' && !replyTarget ? composer : null}
      {expanded ? (
        <Interaction
          key={expanded}
          mode={expanded}
          selfUin={selfUin}
          hostUin={hostUin}
          post={{ ...post, commentNum: commentCount }}
          onSpace={onSpace}
          initialLikes={likes}
          onCommentCount={setCommentCount}
          focusComment={focusComment}
          readComments={writeRevision > 0 ? undefined : readComments}
          confirmedComments={
            commentReadback?.revision === writeRevision && commentReadback.refresh === refresh
              ? commentReadback.page
              : undefined
          }
          writeRevision={writeRevision}
          writePending={likePending}
          renderReply={(comment) => (replyTarget?.id === comment.id ? composer : null)}
          onReply={(comment, root) => {
            setReplyTarget({
              id: comment.id,
              uin: comment.uin,
              nickname: comment.nickname || comment.uin,
              rootId: root.id,
              rootUin: root.uin,
            });
            requestAnimationFrame(() => {
              const input = ref.current?.querySelector<HTMLInputElement>('[aria-label="说说回复"]');
              input?.focus();
              input?.scrollIntoView({ block: 'nearest' });
            });
          }}
        />
      ) : null}
      {forwardOpen ? (
        <QzonePostForwardDialog
          selfUin={selfUin}
          hostUin={hostUin}
          tid={post.tid}
          previousContent={post.content ?? ''}
          onClose={() => setForwardOpen(false)}
        >
          <QzonePersonHeader
            uin={hostUin}
            nickname={hostUin}
            size={34}
            onSpace={onSpace}
            time={<QzoneTime value={post.time} />}
          />
          <p className="weq-qzn-content">
            <QzoneText content={post.content ?? ''} onSpace={onSpace} />
          </p>
          <QzoneMediaGrid images={post.images ?? []} videos={post.videos ?? []} />
          {post.repost ? (
            <section className="weq-qzn-repost">
              <QzonePersonHeader
                uin={/^[1-9]\d{4,19}$/.test(post.repost.uin) ? post.repost.uin : null}
                nickname={post.repost.nickname || post.repost.uin || '原作者'}
                size={26}
                onSpace={onSpace}
                time={<QzoneTime value={post.repost.timeLabel} />}
              />
              <p className="weq-qzn-content">
                <QzoneText content={post.repost.content} onSpace={onSpace} />
              </p>
              <QzoneMediaGrid images={post.repost.images} videos={post.repost.videos} />
            </section>
          ) : null}
        </QzonePostForwardDialog>
      ) : null}
    </div>
  );
  return (
    <QzonePostArchive
      selfUin={selfUin}
      hostUin={hostUin}
      tid={post.tid}
      time={post.time}
      enabled={visible && !readsPaused}
      refresh={refresh}
      onSpace={onSpace}
      onDeleted={onDeleted}
      render={({ tag, menu, upvote }) => render({ tag, menu, actions: renderActions(upvote) })}
    />
  );
}

function FeedCounts({
  selfUin,
  appid,
  body,
}: {
  selfUin: string;
  appid: number;
  body: ReturnType<typeof projectQzoneFeed>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(ref, true);
  const { refresh } = useContext(QzonePageContext);
  const cardData = useContext(FeedCardData);
  const completed = useRef<number | null>(null);
  const [counts, setCounts] = useState<{
    likeCount: number | null;
    commentCount: number | null;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    if (!visible || !body.counterKey || appid !== 4 || completed.current === refresh)
      return undefined;
    const key = `counts:${selfUin}:${body.counterKey}:${refresh}`;
    const cached = cardData?.get<NonNullable<typeof counts>>(key);
    if (cached) {
      setCounts(cached);
      completed.current = refresh;
      setError('');
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    void run(
      (requestId) =>
        client.account.qzone.feedCounts.query({ selfUin, requestId, key: body.counterKey!, appid }),
      true,
    )
      .then((value) => {
        if (live) {
          cardData?.put(key, value);
          setCounts(value);
          completed.current = refresh;
          setError('');
        }
      })
      .catch((reason: unknown) => {
        if (live) setError(errorText(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      cancel();
    };
  }, [visible, selfUin, appid, body.counterKey, refresh, run, cancel, cardData]);
  return (
    <QzoneActionsRow rowRef={ref} title={error || undefined}>
      <span>
        <ThumbsUp size={16} />
        <span className="weq-qzn-action-label">赞</span>{' '}
        <span className="weq-number">{counts?.likeCount ?? body.likeCount ?? '?'}</span>
      </span>
      <span>
        <MessageCircle size={16} />
        <span className="weq-qzn-action-label">评论</span>{' '}
        <span className="weq-number">{counts?.commentCount ?? body.commentCount ?? '?'}</span>
      </span>
      {loading ? <Loader2 size={13} className="weq-spin" aria-label="正在加载互动数据" /> : null}
    </QzoneActionsRow>
  );
}

function Pictures({ images }: { images: string[] }) {
  return <QzoneMediaGrid images={images} />;
}

function Interaction({
  mode,
  selfUin,
  hostUin,
  post,
  onSpace,
  initialLikes,
  onCommentCount,
  focusComment,
  readComments,
  confirmedComments,
  writeRevision = 0,
  writePending = false,
  onReply,
  renderReply,
}: {
  mode: 'comments' | 'likes';
  selfUin: string;
  hostUin: string;
  post: InteractionPost;
  onSpace: (uin: string, nickname?: string) => void;
  initialLikes: QzoneLikesResult | null;
  onCommentCount: (count: number) => void;
  focusComment?: RelatedComment | null;
  readComments?: () => Promise<QzoneInteraction>;
  confirmedComments?: QzoneInteraction;
  writeRevision?: number;
  writePending?: boolean;
  onReply?: (
    comment: QzoneInteraction['comments'][number],
    root: QzoneInteraction['comments'][number],
  ) => void;
  renderReply?: (comment: QzoneInteraction['comments'][number]) => ReactNode;
}) {
  const focusRef = useRef<HTMLDivElement>(null);
  const readsPaused = useContext(QzoneReadPauseContext);
  const { active, refresh } = useContext(QzonePageContext);
  const [result, setResult] = useState<QzoneInteraction | null>(null);
  const [likes, setLikes] = useState<QzoneLikesResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const { run, cancel } = useQzoneRequests();
  const readyLikes = mode === 'likes' ? initialLikes : null;
  useEffect(() => {
    if (active && result && focusRef.current)
      focusRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active, result, focusComment?.id]);
  useEffect(() => {
    if (!active || readsPaused || writePending) return undefined;
    let live = true;
    setError('');
    setLoading(false);
    if (readyLikes) setLikes(readyLikes);
    if (
      readyLikes?.coverage === 'complete' &&
      readyLikes.likes.every((person) => person.nickname.trim() && person.nickname !== person.uin)
    )
      return undefined;
    setLoading(true);
    const applyComments = (page: QzoneInteraction) => {
      if (!live) return;
      // 确认读回比信息流缓存更新；后续补图不能让刚确认的评论消失。
      const comments = [...page.comments];
      for (const confirmed of confirmedComments?.comments ?? []) {
        const index = comments.findIndex(
          (entry) =>
            entry.uin === confirmed.uin &&
            entry.isReply === confirmed.isReply &&
            (entry.id === confirmed.id ||
              (confirmed.isReply &&
                confirmed.replyId !== undefined &&
                entry.replyId === confirmed.replyId &&
                entry.parentCommentId === confirmed.parentCommentId)),
        );
        if (index < 0) comments.push(confirmed);
        else
          comments[index] = { ...comments[index], ...confirmed, images: comments[index]!.images };
      }
      setResult((previous) => ({
        ...page,
        commentCountInclusive:
          confirmedComments?.commentCountInclusive != null
            ? Math.max(page.commentCountInclusive ?? 0, confirmedComments.commentCountInclusive)
            : page.commentCountInclusive,
        comments: comments.map((comment) => {
          if (comment.images.length) return comment;
          const observed = previous?.comments.find(
            (entry) =>
              entry.uin === comment.uin &&
              entry.isReply === comment.isReply &&
              (entry.id === comment.id ||
                (comment.isReply &&
                  comment.replyId !== undefined &&
                  entry.replyId === comment.replyId &&
                  entry.parentCommentId === comment.parentCommentId)) &&
              qzoneReplyPresentation(entry).content === qzoneReplyPresentation(comment).content,
          );
          return observed?.images.length ? { ...comment, images: observed.images } : comment;
        }),
      }));
      if (page.fieldCoverage?.comments === 'complete')
        onCommentCount(comments.filter((comment) => !comment.isReply).length);
    };
    if (mode === 'comments' && confirmedComments && retry === 0) {
      applyComments(confirmedComments);
    }
    void (
      mode === 'comments' && readComments
        ? readComments().then(applyComments)
        : run(async (requestId) => {
            const input = { selfUin, hostUin, tid: post.tid, requestId };
            if (mode === 'likes') {
              const page = readyLikes ?? (await client.account.qzone.likes.query(input));
              if (live) setLikes(page);
              if (
                (page.coverage !== 'complete' ||
                  page.likes.some(
                    (person) => !person.nickname.trim() || person.nickname === person.uin,
                  )) &&
                post.time > 0
              ) {
                try {
                  // Reuse the existing space interaction reader to supplement a
                  // truncated roster; never invent a pagination parameter.
                  const extra = await client.account.qzone.interactions.query({
                    ...input,
                    time: post.time,
                  });
                  const people = new Map(page.likes.map((person) => [person.uin, person]));
                  for (const person of extra.likes) {
                    const existing = people.get(person.uin);
                    if (
                      (!existing && page.coverage !== 'complete') ||
                      (existing &&
                        (!existing.nickname.trim() || existing.nickname === existing.uin) &&
                        person.nickname.trim())
                    )
                      people.set(person.uin, { ...existing, ...person });
                  }
                  const merged = [...people.values()];
                  if (live)
                    setLikes({
                      ...page,
                      likes: merged,
                      coverage: page.coverage === 'complete' ? 'complete' : 'observed',
                      reason:
                        page.reportedTotal !== null && merged.length !== page.reportedTotal
                          ? 'count-mismatch'
                          : page.reason,
                    });
                } catch {
                  // Keep the successful primary roster when supplementation fails.
                }
              }
            } else {
              const page = await client.account.qzone.interactions.query({
                ...input,
                time: post.time,
              });
              applyComments(page);
            }
          })
    )
      .catch((error: unknown) => {
        if (live) setError(errorText(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      cancel();
    };
  }, [
    readsPaused,
    active,
    mode,
    selfUin,
    hostUin,
    post.tid,
    post.time,
    retry,
    refresh,
    run,
    cancel,
    readyLikes,
    onCommentCount,
    readComments,
    confirmedComments,
    writeRevision,
    writePending,
  ]);
  if (!result && !likes && readsPaused)
    return <p className="weq-qzn-status">接口暂不可用，读取已暂停</p>;
  if (!result && !likes)
    return (
      <State loading={!error} error={error} empty="" retry={() => setRetry((value) => value + 1)} />
    );
  if (likes)
    return (
      <div className="weq-qzn-interaction">
        {loading ? <LoadingStatus /> : null}
        {error ? (
          <p className="weq-qzn-error">
            {error}{' '}
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              className="weq-retry-button"
            >
              <RefreshCw size={14} aria-hidden />
              重试
            </button>
          </p>
        ) : null}
        <div className="weq-qzn-like-users">
          {likes.likes.map((like) => (
            <span key={like.uin} title={qzonePlainText(like.nickname || like.uin)}>
              <QzonePersonIdentity
                uin={like.uin}
                nickname={like.nickname}
                onSpace={onSpace}
                size={20}
              />
            </span>
          ))}
        </div>
        <p className="weq-qzn-status">
          {likes.coverage === 'complete' ? (
            likes.likes.length ? (
              <NumericText>{`${likes.likes.length} 人赞过`}</NumericText>
            ) : (
              '还没有人赞过'
            )
          ) : likes.reportedTotal !== null && likes.likes.length > likes.reportedTotal ? (
            <NumericText>{`已读取 ${likes.likes.length} 人，点赞数为 ${likes.reportedTotal}，数据暂不一致`}</NumericText>
          ) : (
            <NumericText>{`已显示 ${likes.likes.length} 人${likes.reportedTotal === null ? '' : `，共 ${likes.reportedTotal} 人`}`}</NumericText>
          )}
        </p>
      </div>
    );
  const roots = result!.comments.filter((comment) => !comment.isReply);
  const replies = result!.comments.filter((comment) => comment.isReply);
  const orphans = replies.filter(
    (reply) => !roots.some((root) => root.id === reply.parentCommentId),
  );
  const focusedComment = focusComment ? relatedCommentTarget(focusComment, result!.comments) : null;
  const renderComment = (source: QzoneInteraction['comments'][number]) => {
    const root = source.isReply
      ? roots.find((entry) => entry.id === source.parentCommentId)
      : source;
    const comment = qzoneReplyPresentation(
      source,
      roots.find((root) => root.id === source.parentCommentId)?.uin,
    );
    return (
      <QzoneCommentRow
        key={comment.id}
        uin={comment.uin}
        nickname={comment.nickname}
        time={comment.time}
        onSpace={onSpace}
        className={`${comment.isReply ? 'is-reply' : ''}${focusedComment?.id === comment.id ? ' is-notification-target' : ''}`.trim()}
        rowRef={focusedComment?.id === comment.id ? focusRef : undefined}
        inline={
          comment.isReply ? (
            <>
              <span>
                {' '}
                回复{' '}
                {comment.replyToUin ? (
                  <QzonePersonButton
                    uin={comment.replyToUin}
                    nickname={comment.replyToNickname}
                    onSpace={onSpace}
                  >
                    <QzoneName
                      content={comment.replyToNickname || comment.replyToUin}
                      uin={comment.replyToUin}
                    />
                  </QzonePersonButton>
                ) : (
                  <QzoneName content={comment.replyToNickname || ''} uin={comment.replyToUin} />
                )}
                ：
              </span>
              <span className="weq-qzn-reply-message">
                <QzoneText content={comment.content} onSpace={onSpace} />
              </span>
            </>
          ) : null
        }
        actions={
          <button type="button" disabled={!root} onClick={() => root && onReply?.(source, root)}>
            回复
          </button>
        }
        afterMeta={renderReply?.(source)}
      >
        {!comment.isReply ? (
          <p>
            <QzoneText content={comment.content} onSpace={onSpace} />
          </p>
        ) : null}
        <Pictures images={comment.images} />
      </QzoneCommentRow>
    );
  };
  return (
    <div className="weq-qzn-interaction">
      {loading ? <LoadingStatus /> : null}
      {error ? (
        <p className="weq-qzn-error">
          {error}{' '}
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="weq-retry-button"
          >
            <RefreshCw size={14} aria-hidden />
            重试
          </button>
        </p>
      ) : null}
      <p className="weq-qzn-status">评论及回复共 {result!.commentCountInclusive ?? '?'} 条</p>
      {focusComment && !focusedComment ? (
        <div ref={focusRef} className="weq-qzn-comment is-notification-target">
          <div>
            <p className="weq-qzn-status">
              {focusComment.source === 'search' ? '搜索中的评论' : '通知中的评论'} ·
              未在本次评论列表中找到
            </p>
            <QzoneText content={focusComment.content} onSpace={onSpace} />
            <Pictures images={focusComment.images} />
          </div>
        </div>
      ) : null}
      {roots.map((root) => (
        <div key={root.id}>
          {renderComment(root)}
          {replies.filter((reply) => reply.parentCommentId === root.id).map(renderComment)}
        </div>
      ))}
      {orphans.map(renderComment)}
      <p className="weq-qzn-status">
        {result!.comments.length ? (
          <NumericText>{`已显示 ${roots.length} 条评论、${replies.length} 条回复`}</NumericText>
        ) : result!.fieldCoverage?.comments === 'complete' &&
          result!.fieldCoverage?.replies === 'complete' ? (
          '暂无评论'
        ) : (
          '暂未读取到评论'
        )}
        {result!.fieldCoverage?.replies !== 'complete' ? ' · 部分回复尚未读取' : ''}
      </p>
    </div>
  );
}

function Feeds({
  selfUin,
  onSpace,
}: {
  selfUin: string;
  onSpace: (uin: string, nickname?: string) => void;
}) {
  const [scope, setScope] = useState<0 | 7>(0);
  return (
    <FeedTimeline
      key={scope}
      selfUin={selfUin}
      onSpace={onSpace}
      scope={scope}
      onScopeChange={setScope}
    />
  );
}

interface FeedSnapshot {
  feeds: QzoneFeed[];
  incomplete: boolean;
  done: boolean;
  nextCursor?: string;
  pages: string[];
  seenCursors: string[];
  stalledPages: number;
  bridge: { cursor: string | undefined; keys: string[]; incomplete: boolean } | null;
}

interface FeedRow {
  key: string;
  selectionId: string;
  reference: ContentReference | null;
  feed: QzoneFeed;
  body: ReturnType<typeof projectQzoneFeed>;
}

// 切到其他栏目时容器会隐藏，保留最后一次可见尺寸和已测的行高。
const observeFeedRect: typeof observeElementRect = (instance, update) =>
  observeElementRect(instance, (rect) => {
    if (rect.height > 0) update(rect);
  });
const observeFeedOffset: typeof observeElementOffset = (instance, update) =>
  observeElementOffset(instance, (offset, scrolling) => {
    if (!instance.scrollElement?.hasAttribute('hidden')) update(offset, scrolling);
  });

function FriendFeedRows({
  rows,
  active,
  selectionMode,
  selected,
  focusRequest,
  itemProps,
  selfUin,
  onSpace,
  lookup,
}: {
  rows: FeedRow[];
  active: boolean;
  selectionMode: boolean;
  selected: ReadonlySet<string>;
  focusRequest: ReturnType<typeof useMultiSelection<string>>['focusRequest'];
  itemProps: (id: string) => MultiSelectionItemProps;
  selfUin: string;
  onSpace: (uin: string, nickname?: string) => void;
  lookup: (feed: QzoneFeed, tid: string | null) => Promise<QzoneEmotion | null>;
}) {
  const content = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(
    () => content.current?.closest<HTMLDivElement>('.weq-qzn-scroll') ?? null,
    [],
  );
  const appliedFocus = useRef<typeof focusRequest>(null);
  const [offset, setOffset] = useState(0);
  const [focused, setFocused] = useState<string>();
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const [cardData] = useState(() => new PageDataCache(128));
  const indices = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const visible = defaultRangeExtractor(range);
      if (!pinned.size && !focused) return visible;
      const retained = new Set(visible);
      for (const key of pinned) {
        const index = indices.get(key);
        if (index !== undefined) retained.add(index);
      }
      const focusedIndex = focused === undefined ? undefined : indices.get(focused);
      if (focusedIndex !== undefined) retained.add(focusedIndex);
      return [...retained].sort((a, b) => a - b);
    },
    [pinned, focused, indices],
  );
  const list = useVirtualizer({
    count: rows.length,
    getScrollElement,
    getItemKey: useCallback((index: number) => rows[index]!.key, [rows]),
    estimateSize: () => 180,
    overscan: 4,
    initialRect: { width: 0, height: 900 },
    observeElementRect: observeFeedRect,
    observeElementOffset: observeFeedOffset,
    useAnimationFrameWithResizeObserver: true,
    measureElement: (element, entry, instance) => {
      const actual = measureElement(element, entry, instance);
      if (actual > 0) return actual;
      const index = instance.indexFromElement(element);
      return (
        instance.itemSizeCache.get(rows[index]?.key ?? '') ?? instance.options.estimateSize(index)
      );
    },
    rangeExtractor,
    scrollMargin: offset,
    anchorTo: 'end',
  });
  useLayoutEffect(() => {
    const scroll = getScrollElement();
    const element = content.current;
    if (!active || !scroll || !element) return;
    const update = () =>
      setOffset(
        element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
      );
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    for (
      let sibling = element.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    )
      observer.observe(sibling);
    return () => observer.disconnect();
  }, [active, getScrollElement, selectionMode]);
  useLayoutEffect(() => {
    if (!active || !focusRequest || appliedFocus.current === focusRequest) return;
    const index = rows.findIndex((row) => row.selectionId === focusRequest.id);
    if (index >= 0) {
      appliedFocus.current = focusRequest;
      list.scrollToIndex(index, { align: 'auto' });
    }
  }, [active, focusRequest, rows, list]);
  const setPinnedRow = useCallback((key: string, keep: boolean) => {
    setPinned((current) => {
      if (keep === current.has(key)) return current;
      const next = new Set(current);
      if (keep) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  return (
    <div
      className="weq-qzn-feed-rows"
      ref={content}
      style={{ height: list.getTotalSize() }}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>('[data-qzone-feed-row]');
        if (row) setFocused(row.dataset.qzoneFeedRow);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
      }}
    >
      <FeedCardData.Provider value={cardData}>
        {list.getVirtualItems().map((virtual) => {
          const row = rows[virtual.index]!;
          return (
            <div
              key={row.key}
              {...(row.selectionId ? itemProps(row.selectionId) : {})}
              ref={list.measureElement}
              data-index={virtual.index}
              data-qzone-feed-row={row.key}
              className={`weq-reference-item${selected.has(row.selectionId) ? ' is-selected' : ''}`}
              style={{ transform: `translateY(${virtual.start - offset}px)` }}
            >
              <FriendFeedCard
                row={row}
                selfUin={selfUin}
                onSpace={onSpace}
                lookup={lookup}
                setPinnedRow={setPinnedRow}
              />
            </div>
          );
        })}
      </FeedCardData.Provider>
    </div>
  );
}

const FriendFeedCard = memo(function FriendFeedCard({
  row,
  selfUin,
  onSpace,
  lookup,
  setPinnedRow,
}: {
  row: FeedRow;
  selfUin: string;
  onSpace: (uin: string, nickname?: string) => void;
  lookup: (feed: QzoneFeed, tid: string | null) => Promise<QzoneEmotion | null>;
  setPinnedRow: (key: string, keep: boolean) => void;
}) {
  const pinCard = useCallback(
    (keep: boolean) => setPinnedRow(row.key, keep),
    [row.key, setPinnedRow],
  );
  return (
    <PinFeedCard.Provider value={pinCard}>
      <FeedCard
        feed={row.feed}
        body={row.body}
        selfUin={selfUin}
        onSpace={onSpace}
        lookup={lookup}
      />
    </PinFeedCard.Provider>
  );
});

function mergeOlderFeedPage(history: QzoneFeed[], added: QzoneFeed[]) {
  added.sort((a, b) => b.time - a.time);
  if (!history.length || history.at(-1)!.time >= added[0]!.time) return history.concat(added);
  const merged: QzoneFeed[] = [];
  let pageIndex = 0;
  for (const feed of history) {
    while (pageIndex < added.length && added[pageIndex]!.time > feed.time)
      merged.push(added[pageIndex++]!);
    merged.push(feed);
  }
  return merged.concat(added.slice(pageIndex));
}

function FeedTimeline({
  selfUin,
  onSpace,
  scope = 0,
  kind = 'friends',
  onScopeChange,
}: {
  selfUin: string;
  onSpace: (uin: string, nickname?: string) => void;
  scope?: 0 | 7;
  kind?: 'friends' | 'related';
  onScopeChange?: (scope: 0 | 7) => void;
}) {
  const { active, refresh } = useContext(QzonePageContext);
  const dataCache = usePageDataCache();
  const cacheKey = JSON.stringify(['feeds', selfUin, scope, kind]);
  const [cached] = useState(() => dataCache.read<FeedSnapshot>(cacheKey));
  const [incomplete, setIncomplete] = useState(cached?.incomplete ?? false);
  const incompleteRef = useRef(incomplete);
  const title = kind === 'friends' ? '好友动态' : '与我相关';
  const relatedRound = useRef(new QzoneRelatedRound());
  const lastRefresh = useRef(refresh);
  const [feeds, setFeeds] = useState<QzoneFeed[] | null>(cached?.feeds ?? null);
  const [error, setError] = useState('');
  const [interactionTab, setInteractionTab] = useState<RelatedKind>('like');
  const suspended = useRef<string | null>(null);
  const readsPaused = kind === 'related' && /HTTP\s*501/i.test(error);
  const [unknownOpen, setUnknownOpen] = useState(false);
  const relatedPanel = useId();
  const [retry, setRetry] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const lastCursor = useRef(cursor);
  const headRequest = useRef(Boolean(cached));
  const [pageRequest, setPageRequest] = useState(0);
  const settledRequest = useRef(cached && kind === 'friends' && refresh === 0 ? '0:0:0' : null);
  const loadCursor = useCallback((value: string) => {
    headRequest.current = false;
    setCursor(value);
    setPageRequest((current) => current + 1);
  }, []);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(cached?.done ?? false);
  const accumulated = useRef<QzoneFeed[]>(cached?.feeds ?? []);
  const keyForFeed = kind === 'related' ? qzoneRelatedKey : qzoneFriendFeedKey;
  const [feedKeys] = useState(() => new Set(accumulated.current.map(keyForFeed)));
  const [snapshotRevision, publishSnapshot] = useState(0);
  const fetchedPages = useRef(new Set<string>(cached?.pages));
  const nextCursor = useRef<string | undefined>(cached?.nextCursor);
  const seenCursors = useRef(new Set<string>(cached?.seenCursors));
  const stalledPages = useRef(cached?.stalledPages ?? 0);
  const bridgeTail = useRef<{
    cursor: string | undefined;
    keys: Set<string>;
    incomplete: boolean;
  } | null>(cached?.bridge ? { ...cached.bridge, keys: new Set(cached.bridge.keys) } : null);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    if (!feeds || !fetchedPages.current.size) return;
    const bridge = bridgeTail.current;
    dataCache.write(cacheKey, {
      feeds,
      incomplete,
      done,
      nextCursor: nextCursor.current,
      pages: [...fetchedPages.current],
      seenCursors: [...seenCursors.current],
      stalledPages: stalledPages.current,
      bridge: bridge ? { ...bridge, keys: [...bridge.keys] } : null,
    } satisfies FeedSnapshot);
  }, [feeds, incomplete, done, cacheKey, dataCache, snapshotRevision]);
  useEffect(() => {
    const recovery = `${refresh}:${retry}`;
    const request = `${refresh}:${pageRequest}:${retry}`;
    if (
      !active ||
      settledRequest.current === request ||
      (kind === 'related' && (suspended.current === recovery || relatedRound.current.exhausted))
    ) {
      setLoading(false);
      return;
    }
    suspended.current = null;
    let live = true;
    setError('');
    setLoading(true);
    if (refresh !== lastRefresh.current) headRequest.current = true;
    else if (cursor !== lastCursor.current) headRequest.current = false;
    lastRefresh.current = refresh;
    lastCursor.current = cursor;
    const refreshing = headRequest.current;
    const pageCursor = refreshing ? undefined : cursor;
    void run<{ feeds: QzoneFeed[]; hasMore: boolean; nextCursor?: string; incomplete?: boolean }>(
      (requestId) => {
        if (kind === 'related')
          return relatedRound.current.take()
            ? client.account.qzone.related.query({
                selfUin,
                requestId,
                offset: Number(new URLSearchParams(pageCursor).get('offset') ?? 0),
              })
            : Promise.reject(new Error('本轮互动读取已完成'));
        return client.account.qzone.feeds.query({ selfUin, requestId, cursor: pageCursor, scope });
      },
    )
      .then((page) => {
        if (!live) return;
        fetchedPages.current.add(pageCursor ?? 'head');
        let carriedTail = false;
        let pageIncomplete = page.incomplete === true;
        const previousSize = feedKeys.size;
        const incoming = page.feeds.map((feed) => [keyForFeed(feed), feed] as const);
        const overlaps = incoming.some(([id]) => feedKeys.has(id));
        const added = new Map<string, QzoneFeed>();
        const replaced = new Map<string, QzoneFeed>();
        const replaceExisting = pageCursor === undefined || kind === 'related';
        for (const [id, feed] of incoming) {
          const known = feedKeys.has(id);
          if (known && !replaceExisting) continue;
          const changes = !known || added.has(id) ? added : replaced;
          changes.set(id, feed);
          feedKeys.add(id);
        }
        const recovering = kind === 'friends' && incompleteRef.current && !nextCursor.current;
        if (
          refreshing &&
          previousSize > 0 &&
          (!overlaps || recovering) &&
          page.hasMore &&
          page.nextCursor
        ) {
          if (!overlaps && !recovering) {
            bridgeTail.current ??= {
              cursor: nextCursor.current,
              keys: new Set(accumulated.current.map(keyForFeed)),
              incomplete: incompleteRef.current,
            };
          } else if (recovering) {
            bridgeTail.current = null;
          }
          seenCursors.current.clear();
          nextCursor.current = page.nextCursor;
          stalledPages.current = 0;
          setDone(false);
        } else if (!refreshing || previousSize === 0) {
          const tail = bridgeTail.current;
          if (tail && incoming.some(([id]) => tail.keys.has(id))) {
            nextCursor.current = tail.cursor;
            bridgeTail.current = null;
            carriedTail = true;
            pageIncomplete = tail.incomplete;
          } else {
            stalledPages.current = feedKeys.size === previousSize ? stalledPages.current + 1 : 0;
            if (pageCursor) seenCursors.current.add(pageCursor);
            const continuation = page.nextCursor;
            nextCursor.current =
              page.hasMore &&
              continuation &&
              continuation !== pageCursor &&
              !seenCursors.current.has(continuation) &&
              stalledPages.current < 3
                ? continuation
                : undefined;
            if (!nextCursor.current) bridgeTail.current = null;
          }
          setDone(!nextCursor.current);
        } else if (kind === 'friends' && !recovering) {
          carriedTail = true;
          pageIncomplete = incompleteRef.current;
        }
        if (
          !carriedTail &&
          page.hasMore &&
          !nextCursor.current &&
          (kind !== 'related' || !refreshing || previousSize === 0 || !overlaps)
        )
          pageIncomplete = true;
        incompleteRef.current = pageIncomplete;
        setIncomplete(pageIncomplete);
        if (replaced.size) {
          // 同时间的已加载动态保留原来的相对顺序。
          accumulated.current = accumulated.current
            .map((feed) => replaced.get(keyForFeed(feed)) ?? feed)
            .concat([...added.values()])
            .sort((a, b) => b.time - a.time);
        } else if (added.size) {
          accumulated.current = mergeOlderFeedPage(accumulated.current, [...added.values()]);
        }
        setFeeds(accumulated.current);
        publishSnapshot((revision) => revision + 1);
      })
      .catch((error: unknown) => {
        if (live) {
          const message = errorText(error);
          if (kind === 'related' && /HTTP\s*501/i.test(message)) suspended.current = recovery;
          setError(message);
        }
      })
      .finally(() => {
        if (live) {
          if (kind === 'friends') settledRequest.current = request;
          setLoading(false);
        }
      });
    return () => {
      live = false;
      cancel();
    };
  }, [
    active,
    selfUin,
    cursor,
    pageRequest,
    retry,
    refresh,
    scope,
    kind,
    run,
    cancel,
    feedKeys,
    keyForFeed,
  ]);
  const continuation = nextCursor.current;
  const roundExhausted = kind === 'related' && relatedRound.current.exhausted;
  const retryFeed = () => {
    if (kind === 'related') relatedRound.current.resume();
    setRetry((value) => value + 1);
  };
  const projections = useRef(
    new Map<
      string,
      {
        feed: QzoneFeed;
        projector: typeof projectQzoneFeed;
        body: ReturnType<typeof projectQzoneFeed>;
        row: FeedRow | null;
      }
    >(),
  );
  const { run: runLookup, cancel: cancelLookup } = useQzoneRequests();
  useEffect(() => {
    if (!active || readsPaused) cancelLookup();
    return () => cancelLookup();
  }, [active, readsPaused, cancelLookup]);
  const lookupPages = useRef(new Map<string, Promise<{ list: QzoneEmotion[]; total: number }>>());
  const relatedPosts = useRef(new Map<string, Promise<QzoneEmotion>>());
  const relatedComments = useRef(new Map<string, Promise<QzoneInteraction>>());
  const [resolvedRelated, setResolvedRelated] = useState<
    Record<string, { target: string; comment: RelatedComment }>
  >({});
  useEffect(() => {
    setResolvedRelated((previous) => (Object.keys(previous).length ? {} : previous));
  }, [refresh, selfUin]);
  const rememberComment = useCallback((key: string, target: string, comment: RelatedComment) => {
    setResolvedRelated((previous) =>
      JSON.stringify(previous[key]) === JSON.stringify({ target, comment })
        ? previous
        : { ...previous, [key]: { target, comment } },
    );
  }, []);
  const lookupRefresh = useRef(refresh);
  if (lookupRefresh.current !== refresh) {
    lookupPages.current.clear();
    relatedPosts.current.clear();
    relatedComments.current.clear();
    lookupRefresh.current = refresh;
  }
  const readRelatedPost = useCallback(
    (hostUin: string, tid: string): Promise<QzoneEmotion> => {
      const key = `${selfUin}:${hostUin}:${tid}`;
      let pending = relatedPosts.current.get(key);
      if (!pending) {
        pending = runLookup(
          (requestId) => client.account.qzone.detail.query({ selfUin, hostUin, tid, requestId }),
          true,
        )
          .then((detail) => {
            if (!detail.post) throw new Error('动态详情未返回完整数据。');
            return detail.post;
          })
          .catch((reason: unknown) => {
            if (relatedPosts.current.get(key) === pending) {
              relatedPosts.current.delete(key);
              if (/HTTP\s*501/i.test(errorText(reason))) {
                suspended.current = `${refresh}:${retry}`;
                setError(errorText(reason));
              }
            }
            throw reason;
          });
        relatedPosts.current.set(key, pending);
      }
      return pending;
    },
    [selfUin, runLookup, refresh, retry],
  );
  const readRelatedComments = useCallback(
    (hostUin: string, tid: string, time: number): Promise<QzoneInteraction> => {
      const key = `${selfUin}:${hostUin}:${tid}`;
      let pending = relatedComments.current.get(key);
      if (!pending) {
        pending = runLookup(
          (requestId) =>
            client.account.qzone.interactions.query({
              selfUin,
              hostUin,
              tid,
              time,
              requestId,
              structuredOnly: true,
            }),
          true,
        ).catch((reason: unknown) => {
          if (relatedComments.current.get(key) === pending) {
            relatedComments.current.delete(key);
            if (/HTTP\s*501/i.test(errorText(reason))) {
              suspended.current = `${refresh}:${retry}`;
              setError(errorText(reason));
            }
          }
          throw reason;
        });
        relatedComments.current.set(key, pending);
      }
      return pending;
    },
    [selfUin, runLookup, refresh, retry],
  );
  const lookupPost = useCallback(
    async (feed: QzoneFeed, tid: string | null): Promise<QzoneEmotion | null> => {
      const timeMatches = new Map<string, QzoneEmotion>();
      for (let offset = 0; offset < 60; offset += 20) {
        const key = `${feed.uin}:${offset}`;
        let pending = lookupPages.current.get(key);
        if (!pending) {
          pending = runLookup(
            (requestId) =>
              client.account.qzone.posts.query({
                selfUin,
                hostUin: String(feed.uin),
                requestId,
                offset,
              }),
            true,
          )
            .then((page) => ({ list: page.list, total: page.total }))
            .catch((error: unknown) => {
              lookupPages.current.delete(key);
              throw error;
            });
          lookupPages.current.set(key, pending);
        }
        const page = await pending;
        const exact = page.list.find((post) => post.tid === tid || post.tid === feed.key);
        if (exact) return exact;
        for (const post of page.list)
          if (feed.time > 0 && post.time === feed.time) timeMatches.set(post.tid, post);
        const knownTimes = page.list.map((post) => post.time).filter((time) => time > 0);
        const crossedTime = feed.time > 0 && knownTimes.some((time) => time < feed.time);
        const reachedEnd = page.list.length === 0 || offset + page.list.length >= page.total;
        if (crossedTime || reachedEnd)
          return timeMatches.size === 1 ? [...timeMatches.values()][0]! : null;
      }
      return null;
    },
    [selfUin, runLookup],
  );
  const currentProjector = projectQzoneFeed;
  const related = useMemo(
    () =>
      kind === 'related'
        ? feeds?.map((feed) => {
            const activity = projectQzoneRelated(feed, selfUin);
            const resolved = resolvedRelated[qzoneRelatedKey(feed)];
            if (
              resolved &&
              resolved.target === `${activity.post?.hostUin}:${activity.post?.tid}` &&
              resolved.comment.uin === activity.actorUin
            ) {
              const kind = activity.kind === 'unknown' ? 'comment' : activity.kind;
              return {
                feed,
                activity: {
                  ...activity,
                  kind,
                  kinds: [kind],
                  comment: resolved.comment,
                  action:
                    activity.kind === 'unknown'
                      ? resolved.comment.isReply
                        ? '回复'
                        : '评论'
                      : activity.action,
                },
              };
            }
            return { feed, activity };
          })
        : undefined,
    [kind, feeds, selfUin, resolvedRelated],
  );
  const unclassified = related?.filter((item) => item.activity.kind === 'unknown') ?? [];
  const relatedTabs = RELATED_TABS.filter(
    (tab) => tab.value !== 'push' || related?.some((item) => item.activity.kind === 'push'),
  );
  const selectedInteractionTab =
    interactionTab === 'push' && !relatedTabs.some((tab) => tab.value === 'push')
      ? 'like'
      : interactionTab;
  const relatedShown = related?.filter((item) => item.activity.kind === selectedInteractionTab);
  const shown = useMemo(
    () =>
      (kind === 'friends' ? feeds : undefined)?.flatMap((feed) => {
        if (feed.uin <= 0) return [];
        const key = qzoneFriendFeedKey(feed);
        const cached = projections.current.get(key);
        if (cached?.feed === feed && cached.projector === currentProjector)
          return cached.row ? [cached.row] : [];
        const body =
          cached?.feed.html === feed.html && cached.projector === currentProjector
            ? cached.body
            : currentProjector(feed.html);
        const tid = body.tid || (/^[a-f0-9]{6,128}$/i.test(feed.key) ? feed.key : null);
        const reference: ContentReference | null =
          feed.appid === 311 && tid
            ? {
                kind: 'qzone-post',
                uin: String(feed.uin),
                tid,
                name: `${feed.nickname}：${body.text.slice(0, 60)}`,
              }
            : null;
        const row = body.advertisement
          ? null
          : {
              key,
              feed,
              body,
              reference,
              selectionId: reference ? contentReferenceKey(reference) : '',
            };
        projections.current.set(key, { feed, projector: currentProjector, body, row });
        return row ? [row] : [];
      }),
    [kind, feeds, currentProjector],
  );
  const pageCountLabel = `（已获取 ${fetchedPages.current.size} 页）`;
  const feedReferences = useMemo(() => {
    const references = new Map<string, ContentReference>();
    for (const row of shown ?? [])
      if (row.reference) references.set(row.selectionId, row.reference);
    return references;
  }, [shown]);
  const feedOwner = { kind: 'qzone-posts' as const, container: `feeds:${selfUin}:${kind}` };
  const feedSelection = useContentMultiSelect(
    feedOwner,
    active && kind === 'friends',
    feedReferences,
  );
  const feedSelectionIds = useMemo(() => [...feedReferences.keys()], [feedReferences]);
  const feedMulti = useMultiSelection({
    ids: feedSelectionIds,
    selected: feedSelection.selectedIds,
    onChange: feedSelection.setSelectedIds,
    enabled: feedSelection.selectionMode,
    disabled: !active,
    onStart: () => feedSelection.setSelectionMode(true),
    onExit: () => feedSelection.setSelectionMode(false),
    anchorRef: feedSelection.anchorRef,
  });
  return (
    <div {...feedMulti.rootProps} className="weq-qzn-timeline">
      {kind === 'friends' && feedReferences.size > 0 && feedSelection.selectionMode ? (
        <ContentReferenceToolbar
          owner={feedOwner}
          selection={feedSelection}
          loaded={feedSelectionIds}
        />
      ) : null}
      <div className="weq-qzn-section-title">
        <h2>{title}</h2>
        {kind === 'friends' ? (
          <FormSelect
            aria-label="动态范围"
            value={scope}
            onChange={(event) => {
              onScopeChange?.(event.target.value === '7' ? 7 : 0);
              const scroll = event.currentTarget.closest('.weq-qzn-scroll');
              if (scroll) scroll.scrollTop = 0;
            }}
          >
            <option value={0}>全部动态</option>
            <option value={7}>特别关心</option>
          </FormSelect>
        ) : null}
      </div>
      {kind === 'related' ? (
        <>
          <div className="weq-qzn-related-tabs" role="tablist" aria-label="互动类型">
            {relatedTabs.map(({ value, label, icon: Icon }, index) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={selectedInteractionTab === value}
                aria-controls={relatedPanel}
                tabIndex={selectedInteractionTab === value ? 0 : -1}
                onClick={() => setInteractionTab(value)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % relatedTabs.length
                      : event.key === 'ArrowLeft'
                        ? (index + relatedTabs.length - 1) % relatedTabs.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? relatedTabs.length - 1
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  setInteractionTab(relatedTabs[next]!.value);
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
              >
                <Icon size={15} />
                {value === 'mention' ? <span className="sr-only">@</span> : label}
                <span aria-hidden="true" title="已加载的互动">
                  <span className="weq-number weq-number-inherit">
                    {related?.filter((item) => item.activity.kind === value).length ?? 0}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div
            id={relatedPanel}
            role="tabpanel"
            aria-label={relatedTabs.find((item) => item.value === selectedInteractionTab)?.label}
          >
            {relatedShown?.map(({ feed, activity }) => (
              <RelatedCard
                key={qzoneRelatedKey(feed)}
                feed={feed}
                activity={activity}
                onSpace={onSpace}
                selfUin={selfUin}
                readPost={readRelatedPost}
                paused={readsPaused}
                readComments={readRelatedComments}
                onComment={rememberComment}
              />
            ))}
            {feeds && !loading && !relatedShown?.length ? (
              <EmptyState compact icon={<MessageCircle />} title="暂无此类互动" />
            ) : null}
          </div>
          {unclassified.length ? (
            <details
              className="weq-qzn-related-unknown"
              onToggle={(event) => setUnknownOpen(event.currentTarget.open)}
            >
              <summary>
                未识别（
                {<span className="weq-number weq-number-inherit">{unclassified.length}</span>}）
              </summary>
              {unknownOpen
                ? unclassified.map(({ feed, activity }) => (
                    <RelatedCard
                      key={qzoneRelatedKey(feed)}
                      feed={feed}
                      activity={activity}
                      onSpace={onSpace}
                      selfUin={selfUin}
                      readPost={readRelatedPost}
                      paused={readsPaused}
                      readComments={readRelatedComments}
                      onComment={rememberComment}
                    />
                  ))
                : null}
            </details>
          ) : null}
        </>
      ) : null}
      {!feeds ? (
        <State
          loading={loading && !error}
          error={error}
          empty=""
          progress={pageCountLabel}
          retry={retryFeed}
        />
      ) : null}
      {shown?.length ? (
        <FriendFeedRows
          rows={shown}
          active={active}
          selectionMode={feedSelection.selectionMode}
          selected={feedSelection.selectedIds}
          focusRequest={feedMulti.focusRequest}
          itemProps={feedMulti.itemProps}
          selfUin={selfUin}
          onSpace={onSpace}
          lookup={lookupPost}
        />
      ) : null}
      <div className="weq-qzn-page-sentinel">
        {feeds && error ? (
          <State
            loading={false}
            error={error}
            empty=""
            progress={pageCountLabel}
            retry={retryFeed}
          />
        ) : null}
        {feeds && !error ? (
          loading ? (
            <p className="weq-qzn-status">
              <Loader2 size={16} className="weq-spin" />
              {headRequest.current ? '正在刷新…' : '正在加载更多…'}
              <NumericText>{pageCountLabel}</NumericText>
            </p>
          ) : !done && continuation ? (
            roundExhausted ? (
              <QzonePageButton
                label="加载更多互动"
                onClick={() => {
                  if (active && relatedRound.current.resume()) loadCursor(continuation);
                }}
              />
            ) : (
              <QzoneAutoPage
                key={continuation}
                loading={false}
                delay={kind === 'related' ? 350 : 0}
                onNext={() => loadCursor(continuation)}
              />
            )
          ) : incomplete && kind === 'friends' ? (
            <State
              loading={false}
              error="QQ 暂未返回可继续读取的位置，已保留加载的动态。"
              empty=""
              progress={pageCountLabel}
              retry={() => {
                stalledPages.current = 0;
                setRetry((value) => value + 1);
              }}
            />
          ) : !incomplete && kind !== 'related' && !shown?.length ? (
            <EmptyState
              icon={<Images />}
              title={scope === 7 ? '暂无特别关心的动态' : '暂时没有可查看的动态'}
              body={pageCountLabel}
            />
          ) : (
            <p className="weq-qzn-status">
              {incomplete
                ? '仍有未加载内容，接口未提供可用的续页位置'
                : kind === 'related'
                  ? '已加载当前返回的互动'
                  : '已加载当前可查看的动态'}
              <NumericText>{pageCountLabel}</NumericText>
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

const RELATED_TABS = [
  { value: 'like', label: '点赞', icon: ThumbsUp },
  { value: 'comment', label: '评论', icon: MessageCircle },
  { value: 'forward', label: '转发', icon: Repeat2 },
  { value: 'mention', label: '@', icon: AtSign },
  { value: 'push', label: '推', icon: Send },
] as const;

function RelatedCard({
  feed,
  activity,
  onSpace,
  selfUin,
  readPost,
  paused = false,
  readComments,
  onComment,
}: {
  feed: QzoneFeed;
  activity: RelatedActivity;
  onSpace: (uin: string, nickname?: string) => void;
  selfUin: string;
  readPost: (hostUin: string, tid: string) => Promise<QzoneEmotion>;
  paused?: boolean;
  readComments: (hostUin: string, tid: string, time: number) => Promise<QzoneInteraction>;
  onComment: (key: string, target: string, comment: RelatedComment) => void;
}) {
  const [open, setOpen] = useState(false);
  const { active } = useContext(QzonePageContext);
  const [fullPost, setFullPost] = useState<QzoneEmotion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const hostUin = activity.post?.hostUin,
    tid = activity.post?.tid;
  const loadComments = useCallback(
    () => readComments(hostUin!, tid!, fullPost?.time ?? 0),
    [readComments, hostUin, tid, fullPost?.time],
  );
  const needsComment =
    (activity.kind === 'comment' ||
      activity.kind === 'unknown' ||
      (activity.kind === 'mention' && !!activity.comment)) &&
    (!activity.comment?.content || activity.comment.isReply === true);
  useEffect(() => {
    if (
      !active ||
      paused ||
      !open ||
      !fullPost ||
      !hostUin ||
      !tid ||
      !activity.actorUin ||
      !needsComment
    )
      return;
    let live = true;
    void loadComments()
      .then((result) => {
        if (!live) return;
        const exact = activity.comment
          ? relatedCommentTarget(activity.comment, result.comments)
          : null;
        const timed = !activity.comment
          ? result.comments.filter(
              (comment) => comment.uin === activity.actorUin && comment.time === feed.time,
            )
          : [];
        const match = exact || (timed.length === 1 ? timed[0] : null);
        if (match) {
          const display = qzoneReplyPresentation(
            match,
            result.comments.find((root) => root.id === match.parentCommentId && !root.isReply)?.uin,
          );
          onComment(qzoneRelatedKey(feed), `${hostUin}:${tid}`, {
            id: match.id,
            uin: match.uin,
            content: display.content,
            images: match.images,
            isReply: match.isReply,
            parentCommentId: match.parentCommentId,
            replyId: match.replyId,
          });
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [
    active,
    paused,
    open,
    fullPost,
    hostUin,
    tid,
    activity.actorUin,
    activity.comment,
    needsComment,
    loadComments,
    onComment,
    feed,
  ]);
  useEffect(() => {
    if (paused) {
      setLoading(false);
      return;
    }
    if (!active || !open || !hostUin || !tid) return;
    let live = true;
    setLoading(true);
    setError('');
    void readPost(hostUin, tid)
      .then((post) => {
        if (live) setFullPost(post);
      })
      .catch((reason: unknown) => {
        if (live) setError(errorText(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [paused, active, open, hostUin, tid, readPost, retry]);
  const limit = Math.max(
    20,
    120 - [...activity.actorName].length - [...activity.action].length - 1,
  );
  const excerpt = fullPost
    ? relatedPostExcerpt(fullPost, limit)
    : [...activity.excerpt].length > limit
      ? `${[...activity.excerpt].slice(0, limit - 1).join('')}…`
      : activity.excerpt;
  const Icon = RELATED_TABS.find((item) => item.value === activity.kind)?.icon ?? MessageCircle;
  return (
    <details
      className="weq-qzn-related-card"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {activity.actorUin ? (
          <QzoneProfileAvatar
            size={34}
            uin={activity.actorUin}
            nickname={activity.actorName}
            onSpace={onSpace}
          />
        ) : (
          <Icon size={24} className="weq-qzn-related-icon" />
        )}
        <span className="weq-qzn-related-summary">
          <span className="weq-qzn-related-action-line">
            {activity.actorUin ? (
              <QzonePersonButton
                className="weq-qzn-related-name"
                uin={activity.actorUin}
                nickname={activity.actorName}
                onSpace={onSpace}
              >
                <QzoneName content={activity.actorName} uin={activity.actorUin} />
              </QzonePersonButton>
            ) : null}
            <span title={relatedActionLine(activity)}>{relatedActionLine(activity)}</span>
          </span>
          {excerpt ? (
            <span className="weq-qzn-related-post-line" title={excerpt}>
              {excerpt}
            </span>
          ) : null}
        </span>
        <QzoneTime value={feed.time} interactive={false} />
        <ChevronDown size={15} className="weq-qzn-related-chevron" />
      </summary>
      <div className="weq-qzn-related-detail">
        {open ? (
          <>
            {loading ? <LoadingStatus /> : null}
            {error ? (
              <p className="weq-qzn-error">
                {error}{' '}
                <button
                  type="button"
                  onClick={() => setRetry((v) => v + 1)}
                  className="weq-retry-button"
                >
                  <RefreshCw size={14} aria-hidden />
                  重试
                </button>
              </p>
            ) : null}
            {fullPost && activity.post ? (
              <QzoneReadPauseContext.Provider value={paused}>
                <Post
                  selfUin={selfUin}
                  hostUin={activity.post.hostUin}
                  nickname={activity.post.nickname}
                  post={fullPost}
                  onSpace={onSpace}
                  focusComment={activity.comment}
                  readComments={loadComments}
                />
              </QzoneReadPauseContext.Provider>
            ) : !loading && !error ? (
              <p className="weq-qzn-status">
                {paused ? '接口暂不可用，自动读取已暂停' : '通知未提供可核验的动态定位信息'}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

const FeedCard = memo(function FeedCard({
  feed,
  body,
  selfUin,
  onSpace,
  lookup,
}: {
  feed: QzoneFeed;
  body: ReturnType<typeof projectQzoneFeed>;
  selfUin: string;
  onSpace: (uin: string, nickname?: string) => void;
  lookup: (feed: QzoneFeed, tid: string | null) => Promise<QzoneEmotion | null>;
}) {
  const tid = body.tid || (/^[a-f0-9]{6,128}$/i.test(feed.key) ? feed.key : null);
  const projectedPost = useMemo<QzoneEmotion | null>(
    () =>
      tid
        ? {
            tid,
            content: body.text,
            contentTruncated: body.contentTruncated,
            time: feed.time,
            commentNum: body.commentCount,
            isPrivate: false,
            images: body.images,
            videos: body.videos,
            repost: body.repost ?? undefined,
            forwardNum: body.forwardCount ?? undefined,
          }
        : null,
    [tid, body, feed.time],
  );
  const ref = useRef<HTMLElement>(null);
  const [post, setPost] = useState<QzoneEmotion | null>(null);
  const { refresh } = useContext(QzonePageContext);
  const [loading, setLoading] = useState(false);
  const needsLookup =
    feed.appid === 311 &&
    (body.unsupported ||
      !(body.text.trim() || body.repost || body.images.length || body.videos.length));
  const visible = useNearViewport(ref, true, needsLookup);
  const settledLookup = useRef<{ feed: QzoneFeed; refresh: number } | null>(null);
  useEffect(() => {
    if (
      !visible ||
      !needsLookup ||
      (settledLookup.current?.feed === feed && settledLookup.current.refresh === refresh)
    )
      return;
    let live = true;
    setLoading(true);
    void lookup(feed, tid)
      .then((post) => {
        if (live) setPost(post);
      })
      .catch(() => {})
      .finally(() => {
        if (live) {
          settledLookup.current = { feed, refresh };
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [visible, needsLookup, feed, tid, lookup, refresh]);
  if (post)
    return (
      <Post
        selfUin={selfUin}
        hostUin={String(feed.uin)}
        nickname={feed.nickname || String(feed.uin)}
        post={post}
        onSpace={onSpace}
        articleRef={ref}
        sourceName={body.sourceName}
        links={body.links}
      />
    );
  if (feed.appid === 311 && tid && /^[a-f0-9]{6,128}$/i.test(tid) && !body.unsupported)
    return (
      <Post
        selfUin={selfUin}
        hostUin={String(feed.uin)}
        nickname={feed.nickname || String(feed.uin)}
        post={projectedPost!}
        onSpace={onSpace}
        articleRef={ref}
        sourceName={body.sourceName}
        links={body.links}
      />
    );
  const render = ({ tag, menu, actions }: PostActionSlots) => (
    <>
      <div className="weq-qzn-post-head">
        <QzonePersonHeader
          uin={String(feed.uin)}
          nickname={feed.nickname}
          onSpace={onSpace}
          size={34}
          time={
            <div className="weq-qzn-post-meta">
              <QzoneTime value={feed.time} />
              {tag}
            </div>
          }
        />
        <span className="weq-qzn-feed-kind">
          {(
            { 311: '说说', 2: '日志', 4: '相册', 202: '分享', 216: '动态' } as Record<
              number,
              string
            >
          )[feed.appid] || '动态'}
        </span>
        {menu ? <div className="weq-qzn-post-tools">{menu}</div> : null}
      </div>
      {body.text.trim() && !body.unsupported ? (
        <p className="weq-qzn-content">
          <QzoneText content={body.text} onSpace={onSpace} />
        </p>
      ) : null}
      {loading ? <LoadingStatus /> : null}
      <QzoneMediaGrid images={body.images} videos={body.videos} />
      {body.repost ? <Repost selfUin={selfUin} original={body.repost} onSpace={onSpace} /> : null}
      <QzoneFeedLinks
        links={body.links}
        ownerUin={String(feed.uin)}
        ownerNickname={feed.nickname}
      />
      {body.sourceName ? <p className="weq-qzn-source">来自 {body.sourceName}</p> : null}
      {actions ?? <FeedCounts selfUin={selfUin} appid={feed.appid} body={body} />}
    </>
  );
  return (
    <article ref={ref} className="weq-qzn-post" key={`${feed.uin}:${feed.appid}:${feed.key}`}>
      {feed.appid === 311 && tid && /^[a-zA-Z0-9_-]{1,128}$/.test(tid) ? (
        <PostActions
          key={`${feed.uin}:${tid}`}
          selfUin={selfUin}
          hostUin={String(feed.uin)}
          post={{
            tid,
            time: feed.time,
            commentNum: body.commentCount,
            content: body.text,
            images: body.images,
            videos: body.videos,
            forwardNum: body.forwardCount ?? undefined,
          }}
          initialLikeCount={body.likeCount}
          onSpace={onSpace}
          render={render}
        />
      ) : (
        render({ tag: null, menu: null, actions: null })
      )}
    </article>
  );
});

function readLegacyImage(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const reader = new FileReader();
    const abort = () => reader.abort();
    signal.addEventListener('abort', abort, { once: true });
    reader.onloadend = () => signal.removeEventListener('abort', abort);
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onabort = () => reject(signal.reason);
    reader.readAsDataURL(file);
  });
}

function Composer({
  selfUin,
  onClose,
  onPublished,
}: {
  selfUin: string;
  onClose: () => void;
  onPublished: (publication: QzonePublication) => void;
}) {
  const [content, setContent] = useState('');
  const [images, setImages] = useState<{ file: File; url: string }[]>([]);
  const previewUrls = useRef(new Set<string>());
  const pendingUpload = useRef<AbortController | null>(null);
  const [visibility, setVisibility] = useState<1 | 4 | 64>(1);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [uploadingImage, setUploadingImage] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pendingUpload.current?.abort();
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current.clear();
    };
  }, []);
  function choose(files: FileList | null): void {
    if (!files || locked.current) return;
    const picked = Array.from(files);
    if (
      picked.length + images.length > 9 ||
      picked.some(
        (file) =>
          !file.size ||
          file.size > QZONE_IMAGE_MAX_BYTES ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(file.type),
      ) ||
      picked.reduce((n, file) => n + file.size, 0) +
        images.reduce((n, image) => n + image.file.size, 0) >
        30 * 1024 * 1024
    ) {
      setError('最多选择 9 张 JPG、PNG 或 WebP 图片，每张不超过 10 MB，合计不超过 30 MB。');
      return;
    }
    setError('');
    const entries = picked.map((file) => {
      const url = URL.createObjectURL(file);
      previewUrls.current.add(url);
      return { file, url };
    });
    setImages((old) => [...old, ...entries]);
  }
  function removeImage(url: string) {
    URL.revokeObjectURL(url);
    previewUrls.current.delete(url);
    setImages((old) => old.filter((image) => image.url !== url));
  }
  async function publish(): Promise<void> {
    if (locked.current || uncertain || !content.trim()) return;
    locked.current = true;
    const controller = new AbortController();
    pendingUpload.current = controller;
    const { signal } = controller;
    setBusy(true);
    setError('');
    let submitted = false;
    try {
      const richvals: string[] = [];
      const config =
        IS_WEB && images.length ? await client.account.getAccountConfig.query() : undefined;
      const binding =
        config?.configId && String(config.uin) === selfUin
          ? { expectedAccountUin: selfUin, expectedAccountConfigId: config.configId }
          : undefined;
      if (IS_WEB && images.length && !binding) throw new Error('账号已切换，请重新打开空间。');
      for (const [index, image] of images.entries()) {
        signal.throwIfAborted();
        setUploadingImage(index);
        setStage(`已上传 ${index}/${images.length} 张`);
        if (binding && config?.qzoneStagedImageUpload === true) {
          const { uploadId } = await stageAccountFile(image.file, binding, signal);
          try {
            signal.throwIfAborted();
            const result = await client.account.qzone.uploadImage.mutate({
              selfUin,
              uploadId,
              expectedAccountConfigId: binding.expectedAccountConfigId,
            });
            richvals.push(result.richval);
          } catch (error) {
            await client.account.pickedFileDiscard
              .mutate({ ...binding, uploadId })
              .catch(() => undefined);
            throw error;
          }
        } else {
          const base64 = await readLegacyImage(image.file, signal);
          signal.throwIfAborted();
          richvals.push(
            (await client.account.qzone.uploadImage.mutate({ selfUin, base64 })).richval,
          );
        }
      }
      signal.throwIfAborted();
      setUploadingImage(null);
      setStage('正在发表');
      submitted = true;
      const result = await client.account.qzone.publish.mutate({
        selfUin,
        content,
        richvals,
        visibility,
      });
      if (active.current) onPublished(result);
    } catch (error) {
      if (active.current) {
        setUncertain(submitted);
        setError(
          submitted
            ? `${errorText(error)} 请先查看我的动态确认结果，再决定是否重新发表。`
            : errorText(error),
        );
      }
    } finally {
      pendingUpload.current = null;
      locked.current = false;
      if (active.current) {
        setBusy(false);
        setStage('');
        setUploadingImage(null);
      }
    }
  }
  return (
    <Modal
      width={600}
      onClose={busy ? undefined : onClose}
      labelledBy="weq-qzn-compose-title"
      dismissOnOutside={false}
      className="weq-qzn-compose-modal"
    >
      <section className="weq-qzn-composer">
        <header>
          <h2 id="weq-qzn-compose-title">写说说</h2>
          <button type="button" disabled={busy} onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <textarea
          aria-label="说说内容"
          autoFocus
          placeholder="分享此刻的心情…"
          value={content}
          maxLength={10_000}
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
        />
        <div className="weq-qzn-draft-images">
          {images.map((image, index) => (
            <span key={image.url}>
              <img src={image.url} alt={image.file.name} />
              {uploadingImage === index && (
                <span className="weq-transfer-media-action">
                  <TransferRing
                    progress={{ phase: 'upload' }}
                    label={`正在上传${image.file.name}`}
                    size={19}
                  />
                </span>
              )}
              <button
                type="button"
                aria-label={`移除图片 ${index + 1}`}
                disabled={busy}
                onClick={() => removeImage(image.url)}
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        <footer>
          <label className={`weq-qzn-file${busy ? ' is-disabled' : ''}`}>
            <ImagePlus size={17} />
            图片
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={busy}
              onChange={(event) => {
                choose(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          <FormSelect
            aria-label="说说可见范围"
            disabled={busy}
            value={visibility}
            onChange={(event) => setVisibility(Number(event.target.value) as 1 | 4 | 64)}
          >
            {QZONE_VISIBILITY.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FormSelect>
          <button
            type="button"
            className="weq-qzn-primary"
            disabled={busy || uncertain || !content.trim()}
            onClick={() => void publish()}
          >
            {busy ? (
              <TransferRing
                progress={{ phase: 'preparing' }}
                label={stage || '正在准备发表'}
                size={15}
              />
            ) : (
              <Send size={15} />
            )}
            {stage || '发表'}
          </button>
        </footer>
        {error ? (
          <p role="alert" className="weq-qzn-status">
            {error}
          </p>
        ) : null}
        {uncertain ? (
          <button
            type="button"
            onClick={() => {
              onClose();
            }}
          >
            关闭并确认发表结果
          </button>
        ) : null}
      </section>
    </Modal>
  );
}
