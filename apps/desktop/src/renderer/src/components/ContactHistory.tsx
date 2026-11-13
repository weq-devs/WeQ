import { TimeLabel } from './TimeLabel';
import { eventTimeFormatter } from '@weq/time';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useTabActive } from './RetainedTabs';
import '../styles/contact-history.css';
import { contactHistorySection, type ContactWorkspaceSection } from '../lib/contactWorkspace';

const _time = eventTimeFormatter;
const labels: Record<string, string> = {
  getProfile: '个人资料',
  getBuddy: '好友资料',
  getBotProfile: '机器人资料',
  exactProfile: '云端资料',
  members: '群成员名单',
  extendedProfile: '群扩展资料',
  getGroupDetail: '群资料',
  getGroupExt: '群活跃信息',
  getGroupNotice: '群公告',
  getGroupBulletins: '本地群公告',
  getHonorList: '群荣誉',
  getFriendDress: '个性装扮',
  getSelfDress: '我的装扮',
  getFriendMutualMark: '互动标识',
  commonRelationships: '共同关系',
  friendClue: '好友来源',
  details: '资料详情',
  energy: '能量值',
  educationHistory: '教育经历',
  signatureHistory: '历史签名',
  personalityLabels: '个性标签',
  personalityPhotos: '个性照片',
  getMemberInfo: '群成员资料',
  listMembersInGroup: '群成员分页',
  fetchOnlineStatus: '在线状态',
  nickname: '本地昵称',
  listBuddies: '好友目录',
  listProfiles: '本地资料目录',
  profilesByUids: '批量个人资料',
  listFriendsByIntimacy: '亲密度资料',
  listExportFriends: '好友导出资料',
  getMemberLevelInfo: '群等级资料',
  getJoinInfo: '群入群资料',
  getMessagePolicy: '群消息策略',
  getMemberNotify: '成员消息提醒',
  getFriendRemark: '好友备注',
  getFriendNotes: '历史备注资料',
  getFriendDisturb: '好友免打扰',
  getFriendSpecialCare: '特别关心',
  editableSelfProfile: '本人资料',
  selfProfileDisplaySettings: '资料展示设置',
  friendRoster: '在线好友目录',
  avatarHistory: '历史头像',
  signatureLikes: '签名互动',
  anonymousDetail: '问答详情',
  anonymousComments: '问答评论',
  anonymousQuestions: '匿问我答',
  listGroupDirectory: '群目录',
  listAllGroups: '群资料目录',
  listAllGroupsExt: '群扩展目录',
  listExportGroups: '群导出资料',
  listAnalysisGroups: '群分析目录',
  listUserGroups: '所在群资料',
  listAnalysisMembers: '群成员分析资料',
  listExportMembers: '群成员导出资料',
  getMembersByUids: '群成员资料',
  getMembersByUins: '群成员资料',
  listLeftMembersInGroup: '已退出成员',
  listMembersByLevel: '群等级名单',
  searchMembersInGroup: '群成员检索',
  listMutedMembers: '群禁言名单',
  getQqLevel: 'QQ 等级',
  getLikeCount: '累计获赞',
  getQqShow: 'QQ 秀',
  fetchShow: 'QQ 秀原始资料',
  joinProfile: '云端群完整资料',
  messagePolicy: '群消息策略',
  getPeerStats: '等级与获赞',
  getOnlineStatus: '本地在线状态',
  getQzoneSpaceStats: '空间资料统计',
  getQzoneNicknames: '空间昵称',
  getVipInfo: '会员资料',
  getSpecialCare: '特别关心名单',
  getQzoneFriendPermissionList: '空间访问设置',
  getGroupEssence: '群精华资料',
  getGroupEssencePage: '群精华分页',
  getEssencePageWithContent: '群精华详情',
  getEssenceMessages: '本地群精华',
  getGroupAlbumList: '群相册目录',
  getGroupAlbumDetails: '群相册资料',
  getGroupAlbumFeed: '群相册动态',
  getGroupAlbumUploadPermission: '群相册上传设置',
  getMediaList: '群相册条目',
  getDaySignedList: '群签到',
  list: '群文件目录',
  listRecursive: '群文件完整目录',
  count: '群文件数量',
  space: '群文件容量',
  getPanel: '群礼物面板',
  getAtAllRemain: '全体成员提醒次数',
  getTodoList: '群待办',
  listCategories: '好友分类',
  listBuddyRequests: '好友申请',
  listDoubtFriendRequests: '可疑好友申请',
  listAllNotifications: '群通知',
  listNormalNotifications: '群通知',
  listDoubtNotifications: '可疑群通知',
  fetchOnlineRequests: '在线群申请',
};
const metricLabels: Record<string, string> = {
  level: 'QQ 等级',
  likeCount: '累计获赞',
  addedAt: '添加时间',
  direction: '添加方向',
  commonFriends: '共同好友数',
  commonGroups: '共同群',
  friendCount: '群内好友数',
  activityScore: '群活跃度',
  energy: '能量值',
  source: '添加来源',
  sourceGroup: '来源群',
  schools: '学校',
  joinedAt: '我的入群时间',
  grade: '群等级',
  freezeState: '冻结状态',
};
function categoryName(name: string) {
  return name.startsWith('metric.')
    ? `${metricLabels[name.slice(7)] ?? name}（指标）`
    : (labels[name] ?? labels[name.split('.').at(-1)!] ?? name);
}
const sourceLabel: Record<string, string> = { online: '云端', local: '本地', legacy: '原有缓存' };

/** 历史页仅读取账号配置与本地历史，不使用会触发在线能力检查的写操作 session。 */
export function ContactHistory({
  entity,
  section,
}: {
  entity: string;
  section?: ContactWorkspaceSection;
}) {
  const active = useTabActive();
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active && Boolean(uin),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const binding =
    config.data?.uin === uin && config.data.configId
      ? { expectedAccountUin: uin, expectedAccountConfigId: config.data.configId }
      : null;
  return binding ? (
    <HistoryQuery
      key={`${binding.expectedAccountConfigId}:${uin}:${entity}`}
      entity={entity}
      binding={binding}
      section={section}
    />
  ) : (
    <p role={config.error ? 'alert' : 'status'}>
      {config.error ? `账号读取失败：${config.error.message}` : '正在读取账号…'}
    </p>
  );
}

/** 资料类别筛选：与应用其他筛选同一套按钮 + 弹出列表语言，不再使用原生 select。 */
function HistoryCategoryFilter({
  value,
  options,
  onChange,
  allowAll = true,
}: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  allowAll?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find((option) => option.value === value)?.label ?? '全部';
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  const choose = (next: string) => {
    setOpen(false);
    onChange(next);
    trigger.current?.focus();
  };
  return (
    <div className="contact-history-filter" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="contact-history-filter-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span>资料类别</span>
        <strong>{current}</strong>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <div className="contact-history-filter-menu" role="listbox" aria-label="资料类别">
          {[...(allowAll ? [{ value: '', label: '全部' }] : []), ...options].map((option) => (
            <button
              key={option.value || 'all'}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? 'is-selected' : undefined}
              onClick={() => choose(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HistoryQuery({
  entity,
  binding,
  section,
}: {
  entity: string;
  binding: { expectedAccountUin: string; expectedAccountConfigId: string };
  section?: ContactWorkspaceSection;
}) {
  const active = useTabActive();
  const [category, setCategory] = useState('');
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [selected, setSelected] = useState<number | null>(null);
  const input = { ...binding, entity };
  const categoriesQuery = trpc.account.contactMetrics.history.categories.useQuery(input, {
    enabled: active,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const categories = (categoriesQuery.data ?? []).filter(
    (name) => !section || contactHistorySection(name) === section,
  );
  const selectedCategory = section
    ? categories.includes(category)
      ? category
      : categories[0]
    : category;
  const list = trpc.account.contactMetrics.history.list.useQuery(
    { ...input, category: selectedCategory ?? '', before: cursors.at(-1), limit: 30 },
    {
      enabled: active && (!section || Boolean(selectedCategory)),
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const status = trpc.account.contactMetrics.history.status.useQuery(binding, {
    enabled: active,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (data) => (active && data?.migrating ? 1000 : false),
  });
  const difference = trpc.account.contactMetrics.history.diff.useQuery(
    { ...input, id: selected ?? 1 },
    { enabled: active && selected !== null, retry: false, refetchOnWindowFocus: false },
  );
  return (
    <section className="contact-history" aria-label="资料历史">
      <header className="contact-history-toolbar">
        <HistoryCategoryFilter
          value={selectedCategory ?? ''}
          allowAll={!section}
          options={categories.map((name) => ({ value: name, label: categoryName(name) }))}
          onChange={(value) => {
            setCategory(value);
            setCursors([undefined]);
            setSelected(null);
          }}
        />
        <button
          type="button"
          className="icon-button"
          title="刷新历史"
          aria-label="刷新历史"
          onClick={() => {
            void list.refetch();
            void status.refetch();
          }}
        >
          <RefreshCw size={16} />
        </button>
      </header>
      {status.data?.migrating ? <p role="status">正在迁入已有资料…</p> : null}
      {status.data?.lastError ? <p role="status">{status.data.lastError}</p> : null}
      {status.data?.migrationErrors.length ? (
        <p role="alert">部分旧缓存尚未迁入，原件已保留：{status.data.migrationErrors.join('；')}</p>
      ) : null}
      {categoriesQuery.error ? (
        <p role="alert">
          历史类别读取失败：{categoriesQuery.error.message}
          <button type="button" onClick={() => void categoriesQuery.refetch()}>
            重试
          </button>
        </p>
      ) : section && !selectedCategory && !categoriesQuery.isFetching ? (
        <p role="status">暂无这类资料的历史记录</p>
      ) : list.isLoading ? (
        <p role="status">正在读取历史…</p>
      ) : list.error ? (
        <p role="alert">历史读取失败：{list.error.message}</p>
      ) : !list.data?.rows.length ? (
        <p role="status">暂无资料历史</p>
      ) : (
        <ol className="contact-history-list">
          {list.data.rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="contact-history-entry"
                aria-expanded={selected === row.id}
                onClick={() => setSelected(selected === row.id ? null : row.id)}
              >
                <strong>{categoryName(row.category)}</strong>
                <TimeLabel value={row.first_at} precision="millisecond" />
                <span>
                  {sourceLabel[row.source] ?? row.source} ·{' '}
                  {row.completeness === 'complete'
                    ? '完整列表'
                    : row.completeness === 'page'
                      ? '分页资料'
                      : '已取得字段'}
                </span>
                {row.last_at > row.first_at ? (
                  <span>
                    最近观察 <TimeLabel value={row.last_at} precision="millisecond" />
                  </span>
                ) : null}
              </button>
              {selected === row.id ? (
                <div className="contact-history-detail" data-privacy-sensitive>
                  {difference.isFetching ? (
                    <p role="status">正在读取版本…</p>
                  ) : difference.error ? (
                    <p role="alert">版本读取失败：{difference.error.message}</p>
                  ) : difference.data ? (
                    <>
                      <HistoryChanges
                        before={difference.data.previous?.value}
                        after={difference.data.current.value}
                        complete={
                          difference.data.current.completeness === 'complete' &&
                          difference.data.previous?.completeness === 'complete'
                        }
                      />
                      <details>
                        <summary>完整版本</summary>
                        <HistoryValue value={difference.data.current.value} />
                      </details>
                      {difference.data.current.observedValue !== undefined ? (
                        <details>
                          <summary>本次返回的字段</summary>
                          <HistoryValue value={difference.data.current.observedValue} />
                        </details>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {/* 空列表 / 只有一页时不画分页器：没有可翻的页，页码「1」只会误导。 */}
      {list.data?.rows.length && (cursors.length > 1 || list.data.nextBefore) ? (
        <footer className="contact-history-pagination">
          <button
            type="button"
            className="icon-button"
            title="上一页"
            aria-label="上一页"
            disabled={cursors.length < 2 || list.isFetching}
            onClick={() => {
              setCursors((value) => value.slice(0, -1));
              setSelected(null);
            }}
          >
            <ChevronLeft size={18} />
          </button>
          <span>第 {cursors.length} 页</span>
          <button
            type="button"
            className="icon-button"
            title="下一页"
            aria-label="下一页"
            disabled={!list.data?.nextBefore || list.isFetching}
            onClick={() => {
              const cursor = list.data?.nextBefore;
              if (cursor) setCursors((value) => [...value, cursor]);
              setSelected(null);
            }}
          >
            <ChevronRight size={18} />
          </button>
        </footer>
      ) : null}
    </section>
  );
}

const fields: Record<string, string> = {
  name: '名称',
  text: '内容',
  photoId: '照片编号',
  country: '国家',
  province: '省份',
  city: '城市',
  birthYear: '出生年份',
  birthMonth: '出生月份',
  birthDay: '出生日',
  qid: 'QID',
  bizId: '特权编号',
  opened: '已开通',
  uid: 'UID',
  uin: 'QQ 号',
  nick: '昵称',
  nickname: '昵称',
  card: '群名片',
  remark: '备注',
  memberLevel: '群等级',
  level: '等级',
  groupCode: '群号',
  groupName: '群名称',
  gender: '性别',
  age: '年龄',
  signature: '签名',
  longNick: '签名',
  isFriend: '好友',
  isBot: '机器人',
  extInfo: '扩展资料',
  extRelation: '关系资料',
  items: '条目',
  count: '数量',
  total: '总数',
  value: '值',
  updatedAt: '更新时间',
  attemptedAt: '尝试时间',
  state: '状态',
  error: '错误',
  joinedAt: '入群时间',
  joinTime: '入群时间',
  lastSpeakTime: '最后发言时间',
};
export function HistoryValue({ value }: { value: unknown }) {
  const [count, setCount] = useState(50);
  if (Array.isArray(value))
    return (
      <div className="contact-history-values">
        {value.slice(0, count).map((item, index) => (
          <div className="contact-history-value-item" key={String(index)}>
            <HistoryValue value={item} />
          </div>
        ))}
        {value.length > count ? (
          <button type="button" onClick={() => setCount((n) => n + 50)}>
            继续显示（{value.length - count}）
          </button>
        ) : null}
      </div>
    );
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (row.$type === 'undefined') return <span className="contact-history-value">未返回</span>;
    if (['bigint', 'date', 'number', 'bytes'].includes(String(row.$type)))
      return <span className="contact-history-value">{String(row.value)}</span>;
    const entries = Object.entries(row);
    return (
      <dl className="contact-history-fields">
        {entries.slice(0, count).map(([key, item]) => (
          <div key={key}>
            <dt>{fields[key] ?? key}</dt>
            <dd>
              {item && typeof item === 'object' ? (
                <details>
                  <summary>{Array.isArray(item) ? `${item.length} 项` : '展开'}</summary>
                  <HistoryValue value={item} />
                </details>
              ) : (
                <HistoryValue value={item} />
              )}
            </dd>
          </div>
        ))}
        {entries.length > count ? (
          <button type="button" onClick={() => setCount((n) => n + 50)}>
            继续显示（{entries.length - count}）
          </button>
        ) : null}
      </dl>
    );
  }
  return (
    <span className="contact-history-value">
      {value === undefined
        ? '未记录'
        : value === null
          ? '空'
          : value === ''
            ? '空字符串'
            : typeof value === 'boolean'
              ? value
                ? '是'
                : '否'
              : String(value)}
    </span>
  );
}
function HistoryChanges({
  before,
  after,
  complete,
}: {
  before: unknown;
  after: unknown;
  complete: boolean;
}) {
  if (before === undefined) return <p>首次观察</p>;
  const old =
    before && typeof before === 'object' && !Array.isArray(before)
      ? (before as Record<string, unknown>)
      : { 值: before };
  const next =
    after && typeof after === 'object' && !Array.isArray(after)
      ? (after as Record<string, unknown>)
      : { 值: after };
  if (Array.isArray(after)) {
    const identity = (value: unknown) => {
      const row = value as Record<string, unknown> | null;
      return row && typeof row === 'object'
        ? String(row.uid ?? row.uin ?? row.id ?? JSON.stringify(row))
        : String(value);
    };
    const previous = new Map(
      (Array.isArray(before) ? before : []).map((value) => [identity(value), value]),
    );
    const current = new Map(after.map((value) => [identity(value), value]));
    const added = after.filter((value) => !previous.has(identity(value)));
    const removed = [...previous].filter(([key]) => !current.has(key)).map(([, value]) => value);
    const changed = after
      .filter(
        (value) =>
          previous.has(identity(value)) &&
          JSON.stringify(previous.get(identity(value))) !== JSON.stringify(value),
      )
      .map((value) => ({
        对象: identity(value),
        之前: previous.get(identity(value)),
        之后: value,
      }));
    return (
      <>
        <details>
          <summary>新增 {added.length}</summary>
          <HistoryValue value={added} />
        </details>
        <details>
          <summary>
            {complete ? '退出／移除' : '本次未返回'} {removed.length}
          </summary>
          <HistoryValue value={removed} />
        </details>
        <details>
          <summary>变更 {changed.length}</summary>
          <HistoryValue value={changed} />
        </details>
      </>
    );
  }
  return (
    <dl className="contact-history-changes">
      {[...new Set([...Object.keys(old), ...Object.keys(next)])]
        .filter((key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]))
        .map((key) => (
          <div key={key}>
            <dt>{fields[key] ?? key}</dt>
            <dd>
              <span>之前</span>
              <HistoryValue value={old[key]} />
              <span>之后</span>
              <HistoryValue value={next[key]} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
