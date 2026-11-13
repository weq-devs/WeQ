import { preciseTimeFormatter as eventTimeFormatter, eventTimeFormatter as groupTimeFormatter } from '@weq/time';
import { useContext, useId, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { History, X } from 'lucide-react';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { client } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Modal } from '../Dialog';
import { HistoryValue } from '../ContactHistory';
import { ContactHistoryAvatar } from './ContactHistoryAvatar';
import { ContactFieldHistoryContext as Context } from '../../lib/contactFieldHistoryContext';

export const contactHistoryFieldForLabel: Record<string, string> = {
  昵称: 'nick',
  备注: 'remark',
  个性签名: 'signature',
  QQ: 'uin',
  QID: 'qid',
  UID: 'uid',
  性别: 'gender',
  年龄: 'age',
  生日: 'birthday',
  星座: 'birthday',
  生肖: 'zodiac',
  血型: 'bloodType',
  所在地: 'region',
  职业: 'occupation',
  学校: 'school',
  公司: 'company',
  邮箱: 'email',
  个人说明: 'description',
  'QQ 等级': 'level',
  累计获赞: 'likes',
  已开通特权: 'privileges',
  'QQ 能量值': 'energy',
  能量值: 'energy',
  共同好友: 'commonFriends',
  共同群: 'commonGroups',
  'QQ 亲密度': 'intimacy',
  关系标签: 'relations',
  互动标识: 'marks',
  个性标签: 'labels',
  标签: 'labels',
  个性装扮: 'dress',
  匿问我答: 'questions',
  头像: 'avatar',
  精选照片: 'photos',
  'QQ 秀': 'qqShow',
  添加时间: 'addedAt',
  添加方向: 'direction',
  添加来源: 'source',
  来源群: 'sourceGroup',
  群昵称: 'card',
  专属头衔: 'customTitle',
  群角色: 'role',
  群等级: 'groupLevel',
  入群时间: 'joinedAt',
  最后群发言: 'lastSpeakAt',
  禁言截止: 'muteUntil',
  群名称: 'groupName',
  简介: 'description',
  创建时间: 'createTime',
  我的入群时间: 'joinedAt',
  群地点: 'addressName',
  入群问题: 'entranceQ',
  群容量: 'maxMemberCount',
  群成员数: 'memberCount',
  群内好友数: 'friendCount',
  活跃度: 'activityScore',
  活跃成员: 'activeMemberCount',
  冻结状态: 'freezeState',
};

export function useContactFieldHistoryAvailable(label: string, field?: string) {
  const context = useContext(Context);
  const key = field ?? contactHistoryFieldForLabel[label];
  return Boolean(context && key && context.fields.includes(key));
}

export function ContactFieldHistoryProvider({
  entity,
  memberUid,
  children,
}: {
  entity: string;
  memberUid?: string;
  children: ReactNode;
}) {
  const session = useQQWriteSession(`field-history:${entity}:${memberUid ?? ''}`, true);
  const active = useTabActive();
  const query = useQuery({
    queryKey: ['contact-field-summary', session.binding, entity, memberUid],
    queryFn: () =>
      client.account.contactMetrics.history.fieldSummary.query({
        ...session.binding!,
        entity,
        memberUid,
      }),
    enabled:
      active &&
      Boolean(session.binding) &&
      /^(friend|group):[\w-]+$/.test(entity) &&
      (!memberUid || /^u_[\w-]+$/.test(memberUid)),
    staleTime: 30000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (data) => (active ? (data?.pending ? 150 : 30000) : false),
  });
  return (
    <Context.Provider value={{ entity, memberUid, fields: query.data?.fields ?? [] }}>
      {children}
    </Context.Provider>
  );
}

export function ContactFieldHistoryButton({ field, label }: { field?: string; label: string }) {
  const context = useContext(Context);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const key = field ?? contactHistoryFieldForLabel[label];
  if (!context || !key || !context.fields.includes(key)) return null;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="weq-profile-field-history"
        title={`显示${label}历史`}
        aria-label={`显示${label}历史`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={13} />
      </button>
      {open ? (
        <Context.Provider value={null}>
          <FieldHistoryDialog
            {...context}
            field={key}
            label={label}
            anchor={anchor.current}
            onClose={() => {
              setOpen(false);
              anchor.current?.focus({ preventScroll: true });
            }}
          />
        </Context.Provider>
      ) : null}
    </>
  );
}

function FieldHistoryDialog({
  entity,
  memberUid,
  field,
  label,
  anchor,
  onClose,
}: {
  entity: string;
  memberUid?: string;
  field: string;
  label: string;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const id = useId();
  const active = useTabActive();
  const session = useQQWriteSession(`field-versions:${entity}:${field}`, true);
  const query = useInfiniteQuery({
    queryKey: ['contact-field-versions', session.binding, entity, memberUid, field],
    queryFn: ({ pageParam }) =>
      client.account.contactMetrics.history.fieldVersions.query({
        ...session.binding!,
        entity,
        memberUid,
        field,
        before: pageParam,
        limit: 30,
      }),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    enabled: active && Boolean(session.binding),
    retry: false,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  return (
    <Modal
      presentation="popover"
      anchor={anchor}
      anchorPlacement="side"
      labelledBy={id}
      title={`${label}历史`}
      width={440}
      className="weq-field-history-dialog"
      onClose={onClose}
    >
      <header className="weq-field-history-header">
        <h3 id={id}>{label}历史</h3>
        <button
          type="button"
          className="icon-button"
          title="关闭历史"
          aria-label="关闭历史"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="weq-field-history-body">
        {query.isLoading ? (
          <p role="status">正在读取历史…</p>
        ) : query.error ? (
          <p role="alert">
            历史读取失败
            <button type="button" onClick={() => void query.refetch()}>
              重试
            </button>
          </p>
        ) : (
          <ol>
            {query.data?.pages
              .flatMap((page) => page.rows)
              .map((row) => (
                <li key={row.id}>
                  <time>观察于 {eventTimeFormatter.format(new Date(row.first_at))}</time>
                  {field === 'avatar' ? (
                    <ContactHistoryAvatar value={row.value} />
                  ) : (
                    <HistoryValue value={groupFieldHistoryValue(entity, memberUid, field, row.value)} />
                  )}
                </li>
              ))}
          </ol>
        )}
        {query.hasNextPage ? (
          <button
            type="button"
            className="weq-profile-section-action"
            disabled={query.isFetching}
            onClick={() => void query.fetchNextPage()}
          >
            加载更多
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

/** 群字段的历史沿用当前资料的业务单位，不向弹窗暴露 Unix 秒或标签内部字段。 */
export function groupFieldHistoryValue(
  entity: string,
  memberUid: string | undefined,
  field: string,
  value: unknown,
): unknown {
  if (!entity.startsWith('group:') || memberUid) return value;
  if (['createTime', 'joinedAt'].includes(field) && typeof value === 'number' && value > 1)
    return groupTimeFormatter.format(value * 1000);
  if (
    ['memberCount', 'maxMemberCount', 'friendCount', 'activeMemberCount'].includes(field) &&
    typeof value === 'number'
  )
    return `${value} 人`;
  if (field === 'freezeState' && typeof value === 'number')
    return value === 0 ? '正常' : value === 1 ? '已冻结' : `状态码 ${value}`;
  if (field === 'labels' && value && typeof value === 'object' && !Array.isArray(value)) {
    const labels = value as { labels?: unknown; customLabels?: unknown };
    return [
      ...new Set(
        [labels.labels, labels.customLabels].flatMap((list) =>
          Array.isArray(list)
            ? list.filter((item): item is string => typeof item === 'string')
            : [],
        ),
      ),
    ];
  }
  return value;
}
