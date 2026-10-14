/** Qzone's known web capabilities, rendered in the local WeQ UI. */
import {
  useCallback,
  useLayoutEffect,
  memo,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { ImagePlus, Loader2, MessageCircle, RefreshCw, Send, ThumbsUp, X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from '../components/QqAvatar';
import { QzoneAlbumDialog } from '../components/QzoneAlbumDialog';
import { openLightbox } from '../components/ImageLightbox';
import { openVideoLightbox } from '../components/VideoLightbox';
import { albumMediaUrl, avatarFetchUrl } from '../lib/resourceUrl';
import { projectQzoneFeed, qzoneMediaSource, mergeQzonePosts, qzoneTextParts } from '../lib/qzone';
import { Modal } from '../components/Dialog';
import type { QzoneEmotion, QzoneFeed, QzoneInteraction, QzoneLikesResult } from './qzone_types';
import '../styles/qzone.css';
import { QzoneProfileContext, type QzoneSpaceRequest } from '../lib/qzoneNavigation';
import { QZONE_VISIBILITY } from '../../../shared/qzone';

type Tab = 'feeds' | 'posts' | 'space';
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '加载失败，请重试。';
function timeText(time: number): string {
  return time ? new Date(time * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
}

let activeReads = 0;
const readQueue: (() => void)[] = [];
function queueQzoneRead<T>(work: () => Promise<T>, background: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      activeReads++;
      void Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          activeReads--;
          readQueue.shift()?.();
        });
    };
    if (activeReads < 2) start();
    else if (background) readQueue.push(start);
    else readQueue.unshift(start);
  });
}

const QzonePageContext = createContext({ active: true, refresh: 0 });

/** Keep a tab's DOM, scroll position and reading state while it is hidden. */
function QzonePage({
  active,
  refreshKey,
  children,
}: {
  active: boolean;
  refreshKey: number;
  children: ReactElement;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef(0);
  const entered = useRef(false);
  const previousActive = useRef(false);
  const [entryRefresh, setEntryRefresh] = useState(0);
  useLayoutEffect(() => {
    if (active && !previousActive.current) {
      if (scroll.current) scroll.current.scrollTop = position.current;
      if (entered.current && position.current <= 48) setEntryRefresh((value) => value + 1);
      entered.current = true;
    }
    previousActive.current = active;
  }, [active]);
  const context = useMemo(
    () => ({ active, refresh: refreshKey + entryRefresh }),
    [active, refreshKey, entryRefresh],
  );
  return (
    <div
      className="weq-qzn-scroll"
      hidden={!active}
      ref={scroll}
      onScroll={(event) => {
        if (active) position.current = event.currentTarget.scrollTop;
      }}
    >
      <QzonePageContext.Provider value={context}>{children}</QzonePageContext.Provider>
    </div>
  );
}

/** Mount on the first visit and retain only the current account's workspace. */
export const QzoneWorkspace = memo(function QzoneWorkspace({
  active,
  selfUin,
  nickname,
  spaceRequest,
}: {
  active: boolean;
  selfUin: string;
  nickname: string;
  spaceRequest?: QzoneSpaceRequest | null;
}) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return visited || active ? (
    <div hidden={!active} style={{ height: '100%', minHeight: 0 }}>
      <QzoneView
        active={active}
        selfUin={selfUin}
        nickname={nickname}
        spaceRequest={spaceRequest}
      />
    </div>
  ) : null;
});

function useNearViewport(ref: RefObject<HTMLElement | null>, once = false): boolean {
  const [near, setNear] = useState(false);
  const { active } = useContext(QzonePageContext);
  useEffect(() => {
    if (!active) {
      setNear(false);
      return undefined;
    }
    const element = ref.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setNear(visible);
        if (visible && once) observer.disconnect();
      },
      { root: element.closest('.weq-qzn-scroll'), rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, once, active]);
  return active && near;
}

type QzonePeople = {
  names: Record<string, string>;
  request: (uin: string) => void;
};
const QzonePeopleContext = createContext<QzonePeople>({
  names: {},
  request: () => {},
});
function useQzonePeople(selfUin: string): QzonePeople {
  const [names, setNames] = useState<Record<string, string>>({});
  const known = useRef(names);
  known.current = names;
  const pending = useRef(new Set<string>());
  const attempts = useRef(new Map<string, number>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(true);
  const { run } = useQzoneRequests();
  const request = useCallback(
    (uin: string) => {
      if (
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
            if (active.current) setNames((current) => ({ ...current, ...result }));
          })
          .catch(() => {
            /* Preserve the supplied display name when a public nickname is unavailable. */
          });
      };
      timer.current = setTimeout(flush, 80);
    },
    [selfUin, run],
  );
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);
  return useMemo(() => ({ names, request }), [names, request]);
}

/** Display names may be remarks; the hover title always uses the public nickname. */
function QzoneName({
  content,
  uin,
  preferNickname = false,
}: {
  content: string;
  uin?: string;
  preferNickname?: boolean;
}) {
  const people = useContext(QzonePeopleContext);
  useEffect(() => {
    if (uin) people.request(uin);
  }, [uin, people.request]);
  const nickname = uin ? people.names[uin] : undefined;
  const label = nickname && (preferNickname || !content || content === uin) ? nickname : content;
  const plainNickname = nickname
    ? qzoneTextParts(nickname)
        .map((part) => (part.kind === 'emoji' ? '[QQ表情]' : part.text))
        .join('')
    : '昵称暂不可用';
  return (
    <span
      className="weq-qzn-name"
      title={uin ? `${plainNickname} (${uin})` : undefined}
      onMouseEnter={() => {
        if (uin) people.request(uin);
      }}
    >
      {qzoneTextParts(label).map((part) =>
        part.kind === 'emoji' ? (
          <QzoneEmoji key={`${part.offset}:${part.code}`} code={part.code} />
        ) : (
          <span key={`${part.offset}:text`}>{part.text}</span>
        ),
      )}
    </span>
  );
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
          <button
            key={`${part.offset}:${part.uin}`}
            type="button"
            className="weq-qzn-mention"
            title={`QQ ${part.uin}`}
            onClick={() => onSpace(part.uin, part.text.slice(1))}
          >
            <QzoneName content={part.text} uin={part.uin} />
          </button>
        ) : part.kind === 'emoji' ? (
          <QzoneEmoji key={`${part.offset}:${part.code}`} code={part.code} />
        ) : (
          <span key={`${part.offset}:text`}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Use the existing cached image bridge; direct CDN URLs are blocked by CSP. */
function QzoneEmoji({ code }: { code: string }) {
  const [sourceIndex, setSourceIndex] = useState(0);
  if (sourceIndex >= 2)
    return (
      <span className="weq-qzn-emoji-unavailable" title={`QQ 表情 ${code}`}>
        [QQ表情]
      </span>
    );
  const extension = sourceIndex === 0 ? 'gif' : 'png';
  return (
    <img
      className="weq-qzn-emoji"
      src={avatarFetchUrl(`https://qzonestyle.gtimg.cn/qzone/em/${code}.${extension}`)}
      alt="[QQ表情]"
      title={`QQ 表情 ${code}`}
      loading="lazy"
      onError={() => setSourceIndex((current) => (current === sourceIndex ? current + 1 : current))}
    />
  );
}

/** Explicit cancellation also reaches main-process CGIs over Electron IPC. */
function useQzoneRequests() {
  const ids = useRef(new Set<string>());
  const cancel = useCallback(() => {
    for (const requestId of ids.current)
      void client.account.qzone.cancel.mutate({ requestId }).catch(() => {});
    ids.current.clear();
  }, []);
  useEffect(() => cancel, [cancel]);
  const run = useCallback(
    async <T,>(work: (requestId: string) => Promise<T>, background = false): Promise<T> => {
      const requestId = crypto.randomUUID();
      ids.current.add(requestId);
      try {
        return await queueQzoneRead(() => {
          if (!ids.current.has(requestId)) throw new Error('空间加载已取消。');
          return work(requestId);
        }, background);
      } finally {
        ids.current.delete(requestId);
      }
    },
    [],
  );
  return { run, cancel };
}

export function QzoneView({
  selfUin,
  nickname,
  active = true,
  spaceRequest,
}: {
  selfUin: string;
  nickname: string;
  active?: boolean;
  spaceRequest?: QzoneSpaceRequest | null;
}): ReactElement {
  const people = useQzonePeople(selfUin);
  const initialSpace = spaceRequest?.accountUin === selfUin ? spaceRequest : null;
  const [tab, setTab] = useState<Tab>(
    initialSpace ? (initialSpace.uin === selfUin ? 'posts' : 'space') : 'feeds',
  );
  const handledRequest = useRef<string | null>(null);
  const tabBar = useRef<HTMLElement>(null);
  const [hostUin, setHostUin] = useState(initialSpace?.uin ?? selfUin);
  const [spaces, setSpaces] = useState<string[]>(
    initialSpace && initialSpace.uin !== selfUin ? [initialSpace.uin] : [],
  );
  const [spaceNames, setSpaceNames] = useState<Record<string, string>>({});
  const rememberSpaceName = useCallback((uin: string, name: string) => {
    const value = name.trim();
    if (!value || value === uin) return;
    setSpaceNames((current) => (current[uin] === value ? current : { ...current, [uin]: value }));
  }, []);
  const [inputUin, setInputUin] = useState('');
  const [targetError, setTargetError] = useState('');
  const [refreshes, setRefreshes] = useState<Record<string, number>>({});
  const [visited, setVisited] = useState<Tab[]>([tab]);
  useEffect(() => {
    setVisited((current) => (current.includes(tab) ? current : [...current, tab]));
  }, [tab]);
  useLayoutEffect(() => {
    const bar = tabBar.current;
    const selected = bar?.querySelector<HTMLElement>('[aria-current="page"]');
    const item = selected?.closest<HTMLElement>('.weq-qzn-space-tab') ?? selected;
    if (!bar || !item) return;
    const bounds = bar.getBoundingClientRect();
    const target = item.getBoundingClientRect();
    if (target.left < bounds.left) bar.scrollLeft += target.left - bounds.left;
    else if (target.right > bounds.right) bar.scrollLeft += target.right - bounds.right;
  }, [tab, hostUin]);
  const selectedPage = tab === 'space' ? `space:${hostUin}` : tab;
  const refreshPage = (key: string) =>
    setRefreshes((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
  const [compose, setCompose] = useState(false);
  const openSpace = useCallback(
    (uin: string, name?: string): void => {
      const value = uin.trim();
      if (!/^[1-9]\d{4,19}$/.test(value)) {
        setTargetError('请输入有效的 QQ 号');
        return;
      }
      setTargetError('');
      const publicName = people.names[value] || name;
      if (publicName) rememberSpaceName(value, publicName);
      setHostUin(value);
      if (value === selfUin) setTab('posts');
      else {
        setSpaces((current) => (current.includes(value) ? current : [...current, value]));
        setTab('space');
      }
    },
    [selfUin, people.names, rememberSpaceName],
  );
  useEffect(() => {
    if (
      !active ||
      !spaceRequest ||
      spaceRequest.accountUin !== selfUin ||
      handledRequest.current === spaceRequest.revision
    )
      return;
    handledRequest.current = spaceRequest.revision;
    openSpace(spaceRequest.uin, spaceRequest.nickname);
  }, [active, selfUin, spaceRequest, openSpace]);
  return (
    <QzonePeopleContext.Provider value={people}>
      <section className="weq-qzn" aria-label="QQ 空间">
        <header className="weq-qzn-header">
          <div className="weq-qzn-identity">
            <QqAvatar uin={selfUin} size={36} />
            <div>
              <strong>QQ 空间</strong>
              <QzoneName content={nickname} uin={selfUin} />
            </div>
          </div>
          <div className="weq-qzn-tools">
            <button
              type="button"
              title="刷新空间"
              aria-label="刷新空间"
              onClick={() => refreshPage(selectedPage)}
            >
              <RefreshCw size={17} />
            </button>
            <button type="button" className="weq-qzn-primary" onClick={() => setCompose(true)}>
              <Send size={15} />
              写说说
            </button>
          </div>
        </header>
        <div className="weq-qzn-navigation">
          <nav ref={tabBar} aria-label="空间栏目">
            <button
              type="button"
              aria-current={tab === 'feeds' ? 'page' : undefined}
              onClick={() => setTab('feeds')}
            >
              好友动态
            </button>
            <button
              type="button"
              aria-current={tab === 'posts' ? 'page' : undefined}
              onClick={() => {
                setHostUin(selfUin);
                setTab('posts');
              }}
            >
              我的空间
            </button>
            {spaces.map((uin) => (
              <span className="weq-qzn-space-tab" key={uin}>
                <button
                  type="button"
                  className="weq-qzn-space-title"
                  aria-current={tab === 'space' && hostUin === uin ? 'page' : undefined}
                  onClick={() => {
                    setHostUin(uin);
                    setTab('space');
                  }}
                >
                  <span className="weq-qzn-space-label">
                    <QzoneName content={spaceNames[uin] || uin} uin={uin} /> 的空间
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${spaceNames[uin] || uin} 的空间`}
                  onClick={() => {
                    setSpaces((current) => current.filter((value) => value !== uin));
                    if (tab === 'space' && hostUin === uin) {
                      setHostUin(selfUin);
                      setTab('feeds');
                    }
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </nav>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              openSpace(inputUin);
            }}
          >
            <input
              aria-label="好友 QQ 号"
              placeholder="查看好友空间 · QQ 号"
              value={inputUin}
              onChange={(event) => setInputUin(event.target.value)}
              inputMode="numeric"
            />
            <button type="submit">查看</button>
          </form>
        </div>
        {targetError ? (
          <p className="weq-qzn-status" role="alert">
            {targetError}
          </p>
        ) : null}
        {visited.includes('feeds') || tab === 'feeds' ? (
          <QzonePage active={active && tab === 'feeds'} refreshKey={refreshes.feeds ?? 0}>
            <Feeds selfUin={selfUin} onSpace={openSpace} />
          </QzonePage>
        ) : null}
        {visited.includes('posts') || tab === 'posts' ? (
          <SpaceContent
            active={active && tab === 'posts'}
            refreshKey={refreshes.posts ?? 0}
            selfUin={selfUin}
            hostUin={selfUin}
            nickname={nickname}
            onSpace={openSpace}
            onOwnerNickname={rememberSpaceName}
          />
        ) : null}
        {spaces.map((uin) => (
          <SpaceContent
            key={uin}
            active={active && tab === 'space' && hostUin === uin}
            refreshKey={refreshes[`space:${uin}`] ?? 0}
            selfUin={selfUin}
            hostUin={uin}
            nickname={spaceNames[uin] || uin}
            onSpace={openSpace}
            onOwnerNickname={rememberSpaceName}
          />
        ))}
        {compose && active ? (
          <Composer
            selfUin={selfUin}
            onClose={() => setCompose(false)}
            onPublished={() => {
              setCompose(false);
              setHostUin(selfUin);
              setTab('posts');
              refreshPage('posts');
            }}
          />
        ) : null}
      </section>
    </QzonePeopleContext.Provider>
  );
}

/** Each owner uses the same panes; retain data and scroll independently. */
function SpaceContent({
  active,
  refreshKey,
  selfUin,
  hostUin,
  nickname,
  onSpace,
  onOwnerNickname,
}: {
  active: boolean;
  refreshKey: number;
  selfUin: string;
  hostUin: string;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
  onOwnerNickname: (uin: string, nickname: string) => void;
}) {
  const openProfile = useContext(QzoneProfileContext);
  const [pane, setPane] = useState<'posts' | 'albums'>('posts');
  const [visitedAlbums, setVisitedAlbums] = useState(false);
  const [refreshes, setRefreshes] = useState({ posts: 0, albums: 0 });
  const previousRefresh = useRef(refreshKey);
  useEffect(() => {
    if (previousRefresh.current === refreshKey) return;
    previousRefresh.current = refreshKey;
    setRefreshes((current) => ({ ...current, [pane]: current[pane] + 1 }));
  }, [refreshKey, pane]);
  return (
    <div className="weq-qzn-owner-space" hidden={!active}>
      <nav className="weq-qzn-owner-navigation" aria-label="空间内容">
        <button
          type="button"
          aria-current={pane === 'posts' ? 'page' : undefined}
          onClick={() => setPane('posts')}
        >
          动态
        </button>
        <button
          type="button"
          aria-current={pane === 'albums' ? 'page' : undefined}
          onClick={() => {
            setVisitedAlbums(true);
            setPane('albums');
          }}
        >
          相册
        </button>
        {openProfile ? (
          <button
            type="button"
            className="weq-qzn-owner-profile"
            aria-label={`查看 ${nickname || hostUin} 的资料`}
            onClick={(event) =>
              openProfile(hostUin, nickname, { x: event.clientX, y: event.clientY })
            }
          >
            <QqAvatar uin={hostUin} size={24} />
            <QzoneName content={nickname || hostUin} uin={hostUin} />
          </button>
        ) : null}
      </nav>
      <QzonePage active={active && pane === 'posts'} refreshKey={refreshes.posts}>
        <Posts
          selfUin={selfUin}
          hostUin={hostUin}
          nickname={nickname}
          onSpace={onSpace}
          onOwnerNickname={onOwnerNickname}
        />
      </QzonePage>
      {visitedAlbums ? (
        <QzonePage active={active && pane === 'albums'} refreshKey={refreshes.albums}>
          <QzoneAlbums hostUin={hostUin} onClose={() => setPane('posts')} />
        </QzonePage>
      ) : null}
    </div>
  );
}

function QzoneAlbums({ hostUin, onClose }: { hostUin: string; onClose: () => void }) {
  const { active, refresh } = useContext(QzonePageContext);
  return (
    <QzoneAlbumDialog
      open
      embedded
      active={active}
      refreshKey={refresh}
      hostUin={hostUin}
      onClose={onClose}
    />
  );
}

function LoadingStatus({ text = '正在加载…' }: { text?: string }) {
  return (
    <p className="weq-qzn-loading" role="status">
      <Loader2 size={16} className="weq-spin" />
      {text}
    </p>
  );
}

function State({
  loading,
  error,
  empty,
  retry,
}: {
  loading: boolean;
  error: string;
  empty: string;
  retry?: () => void;
}) {
  return (
    <div className="weq-qzn-state" role="status">
      {loading ? (
        <>
          <Loader2 size={22} className="weq-spin" />
          正在加载…
        </>
      ) : error ? (
        <>
          <span>{error}</span>
          {retry ? (
            <button type="button" onClick={retry}>
              重试
            </button>
          ) : null}
        </>
      ) : (
        empty
      )}
    </div>
  );
}

function Posts({
  selfUin,
  hostUin,
  nickname,
  onSpace,
  onOwnerNickname,
}: {
  selfUin: string;
  hostUin: string;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
  onOwnerNickname: (uin: string, nickname: string) => void;
}) {
  const { refresh } = useContext(QzonePageContext);
  const lastRefresh = useRef(refresh);
  const [posts, setPosts] = useState<QzoneEmotion[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const lastOffset = useRef(offset);
  const headRequest = useRef(false);
  const [pageRequest, setPageRequest] = useState(0);
  const loadOffset = useCallback((value: number) => {
    headRequest.current = false;
    setOffset(value);
    setPageRequest((current) => current + 1);
  }, []);
  const moreRef = useRef<HTMLDivElement>(null);
  const nearEnd = useNearViewport(moreRef);
  const nextOffset = useRef(0);
  const currentPosts = useRef<QzoneEmotion[]>([]);
  const bridgeTail = useRef<{ offset: number; done: boolean; indices: Map<string, number> } | null>(
    null,
  );
  const [done, setDone] = useState(false);
  const doneRef = useRef(done);
  doneRef.current = done;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
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
        setTotal(page.total);
        if (page.nickname) onOwnerNickname(hostUin, page.nickname);
        const previous = currentPosts.current;
        const hadPosts = previous.length > 0;
        const merged = mergeQzonePosts(previous, page.list).sort((a, b) => b.time - a.time);
        const overlaps = page.list.some((post) => previous.some((old) => old.tid === post.tid));
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
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      cancel();
    };
  }, [selfUin, hostUin, offset, pageRequest, retry, refresh, run, cancel, onOwnerNickname]);
  useEffect(() => {
    if (nearEnd && posts.length > 0 && !loading && !done && !error) loadOffset(nextOffset.current);
  }, [nearEnd, posts.length, loading, done, error, loadOffset]);
  return (
    <div className="weq-qzn-timeline">
      <div className="weq-qzn-section-title">
        {total > 0 ? (
          <span>
            {posts.length} / {total}
          </span>
        ) : null}
      </div>
      {loading && posts.length > 0 && headRequest.current ? (
        <LoadingStatus text="正在刷新…" />
      ) : null}
      {posts.map((post) => (
        <Post
          key={post.tid}
          selfUin={selfUin}
          hostUin={hostUin}
          nickname={nickname}
          post={post}
          ownerSpace
          onSpace={onSpace}
        />
      ))}
      {error || (loading && !posts.length) || (!loading && !posts.length) ? (
        <State
          loading={loading}
          error={error}
          empty="这个空间暂无可查看的说说"
          retry={() => setRetry((value) => value + 1)}
        />
      ) : null}
      <div ref={moreRef} className="weq-qzn-page-sentinel">
        {posts.length > 0 && !done && !error ? (
          <button
            type="button"
            className="weq-qzn-more"
            disabled={loading}
            onClick={() => loadOffset(nextOffset.current)}
          >
            {loading ? (
              <>
                <Loader2 size={16} className="weq-spin" />
                加载中…
              </>
            ) : (
              '加载更多说说'
            )}
          </button>
        ) : null}
        {done && posts.length > 0 ? <p className="weq-qzn-status">已到列表末尾</p> : null}
      </div>
    </div>
  );
}

function Post({
  selfUin,
  hostUin,
  nickname,
  post,
  onSpace,
  articleRef,
  ownerSpace = false,
  sourceName = null,
  links = [],
}: {
  selfUin: string;
  hostUin: string;
  nickname: string;
  post: QzoneEmotion;
  onSpace: (uin: string, nickname?: string) => void;
  articleRef?: RefObject<HTMLElement | null>;
  ownerSpace?: boolean;
  sourceName?: string | null;
  links?: ReturnType<typeof projectQzoneFeed>['links'];
}) {
  const openProfile = useContext(QzoneProfileContext);
  const openOwner = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (ownerSpace && openProfile)
      openProfile(hostUin, nickname, { x: event.clientX, y: event.clientY });
    else onSpace(hostUin, nickname);
  };
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
  return (
    <article ref={articleRef} className="weq-qzn-post">
      <div className="weq-qzn-post-head">
        <button
          type="button"
          aria-label={
            ownerSpace ? `查看 ${nickname || hostUin} 的资料` : `进入 ${nickname || hostUin} 的空间`
          }
          onClick={openOwner}
        >
          <QqAvatar uin={hostUin} size={34} />
        </button>
        <div>
          <button type="button" onClick={openOwner}>
            <QzoneName content={nickname} uin={hostUin} />
          </button>
          <time dateTime={new Date(post.time * 1000).toISOString()}>
            {timeText(post.time)}
            {post.isPrivate ? ' · 仅自己可见' : ''}
          </time>
        </div>
      </div>
      {post.content.trim() ? (
        <p className="weq-qzn-content">
          <QzoneText content={post.content} onSpace={onSpace} />
        </p>
      ) : null}
      <Pictures images={images.filter((url) => !links.some((link) => link.cover === url))} />
      <FeedLinks links={links} />
      <QzoneVideos videos={videos} />
      {post.repost ? <Repost selfUin={selfUin} original={post.repost} onSpace={onSpace} /> : null}
      {sourceName ? <p className="weq-qzn-source">来自 {sourceName}</p> : null}
      <PostActions selfUin={selfUin} hostUin={hostUin} post={post} onSpace={onSpace} />
    </article>
  );
}

function QzoneVideos({ videos }: { videos: QzoneEmotion['videos'] }) {
  return (
    <>
      {videos.map((video, index) => {
        const src = qzoneMediaSource(video.videoUrl);
        const cover = qzoneMediaSource(video.coverUrl);
        return src ? (
          <button
            type="button"
            className="weq-qzn-video"
            key={video.videoId || `${index}`}
            onClick={() =>
              openVideoLightbox(albumMediaUrl(src), cover ? albumMediaUrl(cover) : undefined)
            }
          >
            {cover ? <img src={albumMediaUrl(cover)} alt="视频封面" loading="lazy" /> : null}
            <span>播放视频</span>
          </button>
        ) : (
          <p className="weq-qzn-status" key={video.videoId || `${index}`}>
            此视频暂时没有可播放地址
          </p>
        );
      })}
    </>
  );
}

function Repost({
  selfUin,
  original,
  onSpace,
}: {
  selfUin: string;
  original: NonNullable<QzoneEmotion['repost']> & {
    time?: number;
    commentNum?: number | null;
    likeCount?: number | null;
  };
  onSpace: (uin: string, nickname?: string) => void;
}) {
  const validUin = /^[1-9]\d{4,19}$/.test(original.uin);
  return (
    <section className="weq-qzn-repost" aria-label="原帖">
      <div className="weq-qzn-repost-author">
        {validUin ? (
          <button
            type="button"
            className="weq-qzn-person"
            aria-label={`进入 ${original.nickname || original.uin} 的空间`}
            onClick={() => onSpace(original.uin, original.nickname)}
          >
            <QqAvatar uin={original.uin} size={26} />
          </button>
        ) : null}
        {validUin ? (
          <button
            type="button"
            className="weq-qzn-person"
            onClick={() => onSpace(original.uin, original.nickname)}
          >
            <QzoneName content={original.nickname || original.uin} uin={original.uin} />
          </button>
        ) : (
          <strong>
            <QzoneName content={original.nickname || '原作者'} />
          </strong>
        )}
      </div>
      {original.content.trim() ? (
        <p className="weq-qzn-content">
          <QzoneText content={original.content} onSpace={onSpace} />
        </p>
      ) : null}
      <Pictures images={original.images} />
      <QzoneVideos videos={original.videos} />
      {validUin && /^[a-zA-Z0-9_-]{1,128}$/.test(original.tid) ? (
        <PostActions
          key={`${original.uin}:${original.tid}`}
          selfUin={selfUin}
          hostUin={original.uin}
          post={{
            tid: original.tid,
            time: original.time ?? 0,
            commentNum: original.commentNum ?? null,
          }}
          initialLikeCount={original.likeCount ?? null}
          onSpace={onSpace}
        />
      ) : (
        <div className="weq-qzn-actions">
          <span>
            <ThumbsUp size={16} />赞 ?
          </span>
          <span>
            <MessageCircle size={16} />
            评论 ?
          </span>
        </div>
      )}
    </section>
  );
}

type InteractionPost = Pick<QzoneEmotion, 'tid' | 'time'> & {
  commentNum: number | null;
};
function PostActions({
  selfUin,
  hostUin,
  post,
  onSpace,
  initialLikeCount = null,
}: {
  selfUin: string;
  hostUin: string;
  post: InteractionPost;
  onSpace: (uin: string, nickname?: string) => void;
  initialLikeCount?: number | null;
}) {
  const [expanded, setExpanded] = useState<'comments' | 'likes' | null>(null);
  const [likes, setLikes] = useState<QzoneLikesResult | null>(null);
  const [likeError, setLikeError] = useState('');
  const [loading, setLoading] = useState(false);
  const { refresh } = useContext(QzonePageContext);
  const summaryRefresh = useRef<number | null>(null);
  const [commentCount, setCommentCount] = useState(post.commentNum);
  useEffect(() => {
    if (post.commentNum !== null) setCommentCount(post.commentNum);
  }, [post.commentNum]);
  const ref = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(ref, true);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    if (!visible || summaryRefresh.current === refresh) return undefined;
    let live = true;
    setLoading(true);
    void run(
      (requestId) =>
        client.account.qzone.summary.query({
          selfUin,
          hostUin,
          tid: post.tid,
          requestId,
          needCommentCount: post.commentNum === null,
        }),
      true,
    )
      .then((result) => {
        if (live) {
          summaryRefresh.current = refresh;
          if (result.likes) setLikes(result.likes);
          if (result.commentCount !== null) setCommentCount(result.commentCount);
          setLikeError('');
        }
      })
      .catch((error: unknown) => {
        if (live) setLikeError(errorText(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      cancel();
    };
  }, [visible, selfUin, hostUin, post.tid, post.commentNum, refresh, run, cancel]);
  const likeCount = likes?.reportedTotal ?? initialLikeCount;
  return (
    <div ref={ref}>
      <div className="weq-qzn-actions">
        <button
          type="button"
          aria-expanded={expanded === 'likes'}
          title={likeError || undefined}
          onClick={() => setExpanded(expanded === 'likes' ? null : 'likes')}
        >
          <ThumbsUp size={16} />赞 {likeCount ?? '?'}
        </button>
        <button
          type="button"
          aria-expanded={expanded === 'comments'}
          title="评论"
          onClick={() => setExpanded(expanded === 'comments' ? null : 'comments')}
        >
          <MessageCircle size={16} />
          评论 {commentCount ?? '?'}
        </button>
        {loading ? <Loader2 size={13} className="weq-spin" aria-label="正在加载互动数据" /> : null}
      </div>
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
        />
      ) : null}
    </div>
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
    let live = true;
    setLoading(true);
    void run(
      (requestId) =>
        client.account.qzone.feedCounts.query({ selfUin, requestId, key: body.counterKey!, appid }),
      true,
    )
      .then((value) => {
        if (live) {
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
  }, [visible, selfUin, appid, body.counterKey, refresh, run, cancel]);
  return (
    <div ref={ref} className="weq-qzn-actions" title={error || undefined}>
      <span>
        <ThumbsUp size={16} />赞 {counts?.likeCount ?? body.likeCount ?? '?'}
      </span>
      <span>
        <MessageCircle size={16} />
        评论 {counts?.commentCount ?? body.commentCount ?? '?'}
      </span>
      {loading ? <Loader2 size={13} className="weq-spin" aria-label="正在加载互动数据" /> : null}
    </div>
  );
}

function FeedLinks({ links }: { links: ReturnType<typeof projectQzoneFeed>['links'] }) {
  const [error, setError] = useState('');
  return (
    <>
      {links.map((link) => (
        <button
          className="weq-qzn-feed-link"
          key={link.href}
          type="button"
          title={link.href}
          onClick={() => {
            setError('');
            void client.help.openExternal
              .mutate({ url: link.href })
              .then((result) => {
                if (!result.ok) setError(result.error || '链接打开失败');
              })
              .catch((error: unknown) => setError(errorText(error)));
          }}
        >
          {link.cover ? <img src={albumMediaUrl(link.cover)} alt="" loading="lazy" /> : null}
          <span>{link.text}</span>
        </button>
      ))}
      {error ? <p className="weq-qzn-error">{error}</p> : null}
    </>
  );
}

function Pictures({ images }: { images: string[] }) {
  const urls = [
    ...new Set(images.map(qzoneMediaSource).filter((url): url is string => Boolean(url))),
  ];
  return urls.length ? (
    <div className="weq-qzn-pictures">
      {urls.map((url, index) => (
        <Picture key={url} url={url} index={index} />
      ))}
    </div>
  ) : null;
}

function Picture({ url, index }: { url: string; index: number }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return failed ? (
    <span className="weq-qzn-image-unavailable">图片暂时无法加载</span>
  ) : (
    <button
      type="button"
      className="weq-qzn-picture"
      aria-busy={!loaded}
      onClick={() => openLightbox(albumMediaUrl(url), '空间图片')}
    >
      {!loaded ? (
        <Loader2 size={22} className="weq-spin weq-qzn-picture-loader" aria-label="正在加载图片" />
      ) : null}
      <img
        src={albumMediaUrl(url)}
        alt={`空间图片 ${index + 1}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function Interaction({
  mode,
  selfUin,
  hostUin,
  post,
  onSpace,
  initialLikes,
  onCommentCount,
}: {
  mode: 'comments' | 'likes';
  selfUin: string;
  hostUin: string;
  post: InteractionPost;
  onSpace: (uin: string, nickname?: string) => void;
  initialLikes: QzoneLikesResult | null;
  onCommentCount: (count: number) => void;
}) {
  const { refresh } = useContext(QzonePageContext);
  const [result, setResult] = useState<QzoneInteraction | null>(null);
  const [likes, setLikes] = useState<QzoneLikesResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const { run, cancel } = useQzoneRequests();
  const readyLikes = mode === 'likes' ? initialLikes : null;
  useEffect(() => {
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
    void run(async (requestId) => {
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
        const page = await client.account.qzone.interactions.query({ ...input, time: post.time });
        if (live) {
          setResult(page);
          if (page.fieldCoverage?.comments === 'complete')
            onCommentCount(page.comments.filter((comment) => !comment.isReply).length);
        }
      }
    })
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
  ]);
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
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </p>
        ) : null}
        <div className="weq-qzn-like-users">
          {likes.likes.map((like) => (
            <button type="button" key={like.uin} onClick={() => onSpace(like.uin, like.nickname)}>
              <QqAvatar uin={like.uin} size={24} />
              <QzoneName content={like.nickname || like.uin} uin={like.uin} preferNickname />
            </button>
          ))}
        </div>
        <p className="weq-qzn-status">
          {likes.coverage === 'complete'
            ? likes.likes.length
              ? `${likes.likes.length} 人赞过`
              : '还没有人赞过'
            : likes.reportedTotal !== null && likes.likes.length > likes.reportedTotal
              ? `已读取 ${likes.likes.length} 人，点赞数为 ${likes.reportedTotal}，数据暂不一致`
              : `已显示 ${likes.likes.length} 人${likes.reportedTotal === null ? '' : `，共 ${likes.reportedTotal} 人`}`}
        </p>
      </div>
    );
  const roots = result!.comments.filter((comment) => !comment.isReply);
  const replies = result!.comments.filter((comment) => comment.isReply);
  const orphans = replies.filter(
    (reply) => !roots.some((root) => root.id === reply.parentCommentId),
  );
  const renderComment = (comment: QzoneInteraction['comments'][number]) => (
    <div className={`weq-qzn-comment${comment.isReply ? ' is-reply' : ''}`} key={comment.id}>
      <button
        type="button"
        className="weq-qzn-person"
        aria-label={`进入 ${comment.nickname || comment.uin} 的空间`}
        onClick={() => onSpace(comment.uin, comment.nickname)}
      >
        <QqAvatar uin={comment.uin} size={26} />
      </button>
      <div>
        <button
          type="button"
          className="weq-qzn-person"
          onClick={() => onSpace(comment.uin, comment.nickname)}
        >
          <QzoneName content={comment.nickname || comment.uin} uin={comment.uin} />
        </button>
        {comment.replyToNickname ? (
          <span>
            {' '}
            回复{' '}
            {comment.replyToUin ? (
              <button
                type="button"
                className="weq-qzn-person"
                onClick={() => onSpace(comment.replyToUin!, comment.replyToNickname)}
              >
                <QzoneName content={comment.replyToNickname} uin={comment.replyToUin} />
              </button>
            ) : (
              <QzoneName content={comment.replyToNickname} uin={comment.replyToUin} />
            )}
          </span>
        ) : null}
        <p>
          <QzoneText content={comment.content} onSpace={onSpace} />
        </p>
        <Pictures images={comment.images} />
        <div className="weq-qzn-comment-meta">
          <time>{timeText(comment.time)}</time>
        </div>
      </div>
    </div>
  );
  return (
    <div className="weq-qzn-interaction">
      {loading ? <LoadingStatus /> : null}
      {error ? (
        <p className="weq-qzn-error">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </p>
      ) : null}
      <p className="weq-qzn-status">评论及回复共 {result!.commentCountInclusive ?? '?'} 条</p>
      {roots.map((root) => (
        <div key={root.id}>
          {renderComment(root)}
          {replies.filter((reply) => reply.parentCommentId === root.id).map(renderComment)}
        </div>
      ))}
      {orphans.map(renderComment)}
      <p className="weq-qzn-status">
        {result!.comments.length
          ? `已显示 ${roots.length} 条评论、${replies.length} 条回复`
          : result!.fieldCoverage?.comments === 'complete' &&
              result!.fieldCoverage?.replies === 'complete'
            ? '暂无评论'
            : '暂未读取到评论'}
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
  const { refresh } = useContext(QzonePageContext);
  const lastRefresh = useRef(refresh);
  const [feeds, setFeeds] = useState<QzoneFeed[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState(0);
  const [retry, setRetry] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const lastCursor = useRef(cursor);
  const headRequest = useRef(false);
  const [pageRequest, setPageRequest] = useState(0);
  const loadCursor = useCallback((value: string) => {
    headRequest.current = false;
    setCursor(value);
    setPageRequest((current) => current + 1);
  }, []);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const accumulated = useRef<QzoneFeed[]>([]);
  const nextCursor = useRef<string | undefined>(undefined);
  const seenCursors = useRef(new Set<string>());
  const stalledPages = useRef(0);
  const bridgeTail = useRef<{ cursor: string | undefined; keys: Set<string> } | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const nearEnd = useNearViewport(moreRef);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    let live = true;
    setError('');
    setLoading(true);
    if (refresh !== lastRefresh.current) headRequest.current = true;
    else if (cursor !== lastCursor.current) headRequest.current = false;
    lastRefresh.current = refresh;
    lastCursor.current = cursor;
    const refreshing = headRequest.current;
    const pageCursor = refreshing ? undefined : cursor;
    void run((requestId) =>
      client.account.qzone.feeds.query({ selfUin, requestId, cursor: pageCursor }),
    )
      .then((page) => {
        if (!live) return;
        const key = (feed: QzoneFeed): string =>
          `${feed.uin}:${feed.appid}:${feed.key || `${feed.time}:${feed.html}`}`;
        const merged = new Map(accumulated.current.map((feed) => [key(feed), feed]));
        const previousSize = merged.size;
        for (const feed of page.feeds) merged.set(key(feed), feed);
        const overlaps = page.feeds.some((feed) =>
          accumulated.current.some((old) => key(old) === key(feed)),
        );
        if (refreshing && previousSize > 0 && !overlaps && page.hasMore && page.nextCursor) {
          bridgeTail.current ??= {
            cursor: nextCursor.current,
            keys: new Set(accumulated.current.map(key)),
          };
          nextCursor.current = page.nextCursor;
          stalledPages.current = 0;
          setDone(false);
        } else if (!refreshing || previousSize === 0) {
          const tail = bridgeTail.current;
          if (tail && page.feeds.some((feed) => tail.keys.has(key(feed)))) {
            nextCursor.current = tail.cursor;
            bridgeTail.current = null;
          } else {
            stalledPages.current = merged.size === previousSize ? stalledPages.current + 1 : 0;
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
        }
        accumulated.current = [...merged.values()].sort((a, b) => b.time - a.time);
        setFeeds(accumulated.current);
      })
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
  }, [selfUin, cursor, pageRequest, retry, refresh, run, cancel]);
  useEffect(() => {
    if (nearEnd && !loading && !error && !done && nextCursor.current)
      loadCursor(nextCursor.current);
  }, [nearEnd, loading, error, done, feeds, loadCursor]);
  const projections = useRef(
    new Map<
      string,
      {
        html: string;
        projector: typeof projectQzoneFeed;
        body: ReturnType<typeof projectQzoneFeed>;
      }
    >(),
  );
  const { run: runLookup } = useQzoneRequests();
  const lookupPages = useRef(new Map<string, Promise<{ list: QzoneEmotion[]; total: number }>>());
  const lookupRefresh = useRef(refresh);
  if (lookupRefresh.current !== refresh) {
    lookupPages.current.clear();
    lookupRefresh.current = refresh;
  }
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
  const shown = useMemo(
    () =>
      feeds
        ?.filter((feed) => feed.uin > 0)
        .map((feed) => {
          const key = `${feed.uin}:${feed.appid}:${feed.key || feed.time}`;
          const cached = projections.current.get(key);
          const reusable = cached?.html === feed.html && cached.projector === currentProjector;
          const body = reusable ? cached.body : currentProjector(feed.html);
          if (!reusable)
            projections.current.set(key, { html: feed.html, projector: currentProjector, body });
          return { feed, body };
        })
        .filter(
          ({ feed, body }) =>
            !body.advertisement &&
            (!filter ||
              (filter === -1 ? ![311, 2, 4].includes(feed.appid) : feed.appid === filter)),
        ),
    [feeds, filter, currentProjector],
  );
  return (
    <div className="weq-qzn-timeline">
      <div className="weq-qzn-section-title">
        <h2>好友动态</h2>
        <select
          aria-label="动态类型"
          value={filter}
          onChange={(event) => setFilter(Number(event.target.value))}
        >
          <option value={0}>全部动态</option>
          <option value={311}>说说</option>
          <option value={2}>日志</option>
          <option value={4}>相册</option>
          <option value={-1}>其他动态</option>
        </select>
      </div>
      {!feeds ? (
        <State
          loading={loading && !error}
          error={error}
          empty=""
          retry={() => setRetry((value) => value + 1)}
        />
      ) : null}
      {shown?.map(({ feed, body }) => (
        <FeedCard
          key={`${feed.uin}:${feed.appid}:${feed.key || feed.time}`}
          feed={feed}
          body={body}
          selfUin={selfUin}
          onSpace={onSpace}
          lookup={lookupPost}
        />
      ))}
      <div ref={moreRef} className="weq-qzn-page-sentinel">
        {feeds && error ? (
          <State
            loading={false}
            error={error}
            empty=""
            retry={() => setRetry((value) => value + 1)}
          />
        ) : null}
        {feeds && !error ? (
          loading ? (
            <p className="weq-qzn-status">
              <Loader2 size={16} className="weq-spin" />
              {headRequest.current ? '正在刷新动态…' : '正在加载更多动态…'}
            </p>
          ) : !done ? (
            <button
              type="button"
              className="weq-qzn-more"
              onClick={() => {
                if (nextCursor.current) loadCursor(nextCursor.current);
              }}
            >
              加载更多动态
            </button>
          ) : (
            <p className="weq-qzn-status">
              {shown?.length
                ? '已加载当前可查看的动态'
                : filter
                  ? '暂无此类型动态'
                  : '暂时没有可查看的动态'}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

function FeedCard({
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
  const ref = useRef<HTMLElement>(null);
  const visible = useNearViewport(ref, true);
  const [post, setPost] = useState<QzoneEmotion | null>(null);
  const { refresh } = useContext(QzonePageContext);
  const [loading, setLoading] = useState(false);
  const needsLookup =
    feed.appid === 311 && (body.unsupported || (!body.text.trim() && !body.repost));
  useEffect(() => {
    if (!visible || !needsLookup) return undefined;
    let live = true;
    setLoading(true);
    void lookup(feed, tid)
      .then((post) => {
        if (live) setPost(post);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoading(false);
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
  return (
    <article ref={ref} className="weq-qzn-post" key={`${feed.uin}:${feed.appid}:${feed.key}`}>
      <div className="weq-qzn-post-head">
        <button
          type="button"
          aria-label={`进入 ${feed.nickname || feed.uin} 的空间`}
          onClick={() => onSpace(String(feed.uin), feed.nickname)}
        >
          <QqAvatar uin={String(feed.uin)} size={34} />
        </button>
        <div>
          <button type="button" onClick={() => onSpace(String(feed.uin), feed.nickname)}>
            <QzoneName content={feed.nickname || String(feed.uin)} uin={String(feed.uin)} />
          </button>
          <time>{timeText(feed.time)}</time>
        </div>
        <span className="weq-qzn-feed-kind">
          {({ 311: '说说', 2: '日志', 4: '相册', 216: '动态' } as Record<number, string>)[
            feed.appid
          ] || '动态'}
        </span>
      </div>
      {body.text.trim() && !body.unsupported ? (
        <p className="weq-qzn-content">
          <QzoneText content={body.text} onSpace={onSpace} />
        </p>
      ) : null}
      {loading ? <LoadingStatus /> : null}
      <Pictures images={body.images} />
      {body.repost ? <Repost selfUin={selfUin} original={body.repost} onSpace={onSpace} /> : null}
      <FeedLinks links={body.links} />
      {body.sourceName ? <p className="weq-qzn-source">来自 {body.sourceName}</p> : null}
      {feed.appid === 311 && tid && /^[a-zA-Z0-9_-]{1,128}$/.test(tid) ? (
        <PostActions
          selfUin={selfUin}
          hostUin={String(feed.uin)}
          post={{
            tid,
            time: feed.time,
            commentNum: body.commentCount,
          }}
          initialLikeCount={body.likeCount}
          onSpace={onSpace}
        />
      ) : (
        <FeedCounts selfUin={selfUin} appid={feed.appid} body={body} />
      )}
    </article>
  );
}

function Composer({
  selfUin,
  onClose,
  onPublished,
}: {
  selfUin: string;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [content, setContent] = useState('');
  const [images, setImages] = useState<
    { id: string; base64: string; name: string; type: string }[]
  >([]);
  const [visibility, setVisibility] = useState<1 | 4 | 64>(1);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(true),
    locked = useRef(false);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  async function choose(files: FileList | null): Promise<void> {
    if (!files || locked.current || reading) return;
    const picked = Array.from(files);
    if (
      picked.length + images.length > 9 ||
      picked.some(
        (file) =>
          file.size > 10 * 1024 * 1024 ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(file.type),
      ) ||
      picked.reduce((n, file) => n + file.size, 0) +
        images.reduce((n, image) => n + image.base64.length * 0.75, 0) >
        30 * 1024 * 1024
    ) {
      setError('最多选择 9 张 JPG、PNG 或 WebP 图片，每张不超过 10 MB，合计不超过 30 MB。');
      return;
    }
    setReading(true);
    setError('');
    try {
      const entries: { id: string; base64: string; name: string; type: string }[] = [];
      for (const file of picked) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]!);
          reader.onerror = () => reject(new Error('图片读取失败'));
          reader.readAsDataURL(file);
        });
        entries.push({ id: crypto.randomUUID(), base64: data, name: file.name, type: file.type });
      }
      if (active.current) setImages((old) => [...old, ...entries]);
    } catch (error) {
      if (active.current) setError(errorText(error));
    } finally {
      if (active.current) setReading(false);
    }
  }
  async function publish(): Promise<void> {
    if (locked.current || reading || uncertain || !content.trim()) return;
    locked.current = true;
    setBusy(true);
    setError('');
    let submitted = false;
    try {
      const richvals: string[] = [];
      for (const [index, image] of images.entries()) {
        setStage(`上传图片 ${index + 1}/${images.length}`);
        const result = await client.account.qzone.uploadImage.mutate({
          selfUin,
          base64: image.base64,
        });
        richvals.push(result.richval);
      }
      setStage('正在发表');
      submitted = true;
      await client.account.qzone.publish.mutate({ selfUin, content, richvals, visibility });
      if (active.current) onPublished();
    } catch (error) {
      if (active.current) {
        setUncertain(submitted);
        setError(
          submitted
            ? `${errorText(error)} 请先刷新我的动态确认结果，再决定是否重新发表。`
            : errorText(error),
        );
      }
    } finally {
      locked.current = false;
      if (active.current) {
        setBusy(false);
        setStage('');
      }
    }
  }
  return (
    <Modal
      width={600}
      onClose={busy ? undefined : onClose}
      labelledBy="weq-qzn-compose-title"
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
            <span key={image.id}>
              <img src={`data:${image.type};base64,${image.base64}`} alt={image.name} />
              <button
                type="button"
                aria-label={`移除图片 ${index + 1}`}
                disabled={busy}
                onClick={() => setImages((old) => old.filter((_, i) => i !== index))}
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        <footer>
          <label className={`weq-qzn-file${busy || reading ? ' is-disabled' : ''}`}>
            <ImagePlus size={17} />
            图片
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={busy || reading}
              onChange={(event) => {
                void choose(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          <select
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
          </select>
          <button
            type="button"
            className="weq-qzn-primary"
            disabled={busy || reading || uncertain || !content.trim()}
            onClick={() => void publish()}
          >
            {busy || reading ? <Loader2 size={15} className="weq-spin" /> : <Send size={15} />}
            {stage || (reading ? '读取图片' : '发表')}
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
