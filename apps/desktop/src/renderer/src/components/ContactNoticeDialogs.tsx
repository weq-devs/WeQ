/**
 * 好友通知 / 群通知两个灯箱。
 *
 * 原先住在 `im-template/template/noticePanes.tsx`（模板只该放上游 IM 层的东西），
 * 2026-10-17 随「浮层统一」搬到 WeQ 侧：外壳改走 {@link ./OverlayLayer}，
 * 于是 portal / 层级 / Esc / 点遮罩关闭都是同一套，不再各自手写。
 *
 * 数据与开关都由应用层给：`open` 由 MainView 的 `shell.contactNotice` 驱动，
 * `requests` 是已经取好的申请列表。
 */
import { ArrowLeft, Bell, Users } from 'lucide-react';
import { cn } from '../im-template/template/classNames';
import { formatProfileDate } from '../im-template/template/format';
import { Avatar, EmptyState } from '../im-template/template/primitives';
import type { ContactRequest, GroupJoinRequest, User } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { OverlayLayer } from './OverlayLayer';
import { PageShell } from './PageShell';
import { RequestActions, useNoticeOperations } from './qq-actions/RequestActions';
import { withQQAccountScope } from './qq-actions/shared';
import { bindNoticeOperations, type NoticeOperation } from '../lib/contactNotice';
import { avatarFromUin } from '../lib/avatarResolver';
import '../styles/contact-notices.css';

export type NoticeProfileHandler = (
  user: User,
  anchor: { x: number; y: number },
  group?: { code: string; name: string },
) => void;

/**
 * 好友通知灯箱。沿用 weq 设计：遮罩 + 居中卡片，固定标题 + 可滚动列表。
 * 待处理申请直接在卡片内操作，其他通知仅展示。
 */
function ContactNoticeDialogBody({
  open,
  requests,
  onClose,
  onOpenProfile,
}: {
  open: boolean;
  requests: ContactRequest[];
  onClose: () => void;
  onOpenProfile?: NoticeProfileHandler;
}) {
  const inbox = useNoticeOperations(false, open);
  const { cards, remaining } = bindNoticeOperations(requests, inbox.operations);
  return (
    <OverlayLayer
      presentation="page"
      title="好友通知"
      className="weq-profile-layer weq-notice-layer"
      open={open}
      onClose={onClose}
    >
      <section
        className="weq-notice-dialog weq-anim-pop"
        role="region"
        aria-label="好友通知"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <PageShell
          title="好友通知"
          icon={<Bell size={15} />}
          leading={
            <button
              className="weq-page-back"
              type="button"
              title="返回"
              aria-label="返回"
              onClick={onClose}
            >
              <ArrowLeft size={18} />
            </button>
          }
        >
          <div
            className={cn(
              'weq-notice-scroll',
              requests.length === 0 && remaining.length === 0 && 'is-empty',
            )}
          >
            {inbox.error && <p role="alert">{inbox.error}</p>}
            {requests.length === 0 && remaining.length === 0 ? (
              <EmptyState
                title="暂无好友通知"
                body="收到或发出的好友申请会显示在这里。"
                icon={<Bell />}
              />
            ) : (
              cards.map(({ notice: request, operation }) => {
                const who = displayUserName(request.user);
                const badge = FRIEND_STATE_LABEL[request.status];
                const fields = splitNoticeMessage(request.message || '请求添加对方为好友');
                return (
                  <article
                    className={cn('notice-card', 'notice-card-request', badge?.tone)}
                    key={request.id}
                  >
                    <NoticeAvatar user={request.user} onOpenProfile={onOpenProfile} />
                    <div className="notice-copy">
                      <p className="notice-line-head">
                        <span className="notice-who" title={who}>
                          {who}
                        </span>
                        <span className="notice-action-text">
                          {request.status === 'accepted'
                            ? '已同意好友申请'
                            : request.direction === 'incoming'
                              ? '请求加为好友'
                              : '正在验证你的邀请'}
                        </span>
                      </p>
                      <dl className="notice-fields">
                        {fields.map((field) => (
                          <div className="notice-field" key={`${field.label ?? ''}${field.value}`}>
                            <dt>{field.label || '留言'}</dt>
                            <dd title={field.value}>{field.value}</dd>
                          </div>
                        ))}
                      </dl>
                      {open && operation && (
                        <RequestActions
                          key={`${operation.kind}:${operation.token}`}
                          operation={operation}
                        />
                      )}
                    </div>
                    <div className="notice-meta">
                      {badge ? (
                        <em className={cn('notice-state', badge.tone)}>{badge.text}</em>
                      ) : null}
                      <time>{formatProfileDate(request.createdAt)}</time>
                    </div>
                  </article>
                );
              })
            )}
            {open &&
              remaining.map((operation) => (
                <OnlineRequestCard
                  key={`${operation.kind}:${operation.token}`}
                  operation={operation}
                  onOpenProfile={onOpenProfile}
                />
              ))}
          </div>
        </PageShell>
      </section>
    </OverlayLayer>
  );
}

const FRIEND_STATE_LABEL: Record<ContactRequest['status'], { text: string; tone: string }> = {
  pending: { text: '待处理', tone: 'is-pending' },
  accepted: { text: '已同意', tone: 'is-agreed' },
  rejected: { text: '已拒绝', tone: 'is-refused' },
  cancelled: { text: '已取消', tone: 'is-refused' },
  unknown: { text: '状态未知', tone: '' },
};

/** 61003 处理状态 → 徽标文案 + 配色修饰类。配色全部走主题色，只用填充/描边区分。 */
const HANDLE_STATE_LABEL: Record<
  GroupJoinRequest['handleState'],
  { text: string; tone: string } | null
> = {
  none: null,
  pending: { text: '待处理', tone: 'is-pending' },
  agreed: { text: '已同意', tone: 'is-agreed' },
  refused: { text: '已拒绝', tone: 'is-refused' },
};

/**
 * 附言拆成「标签 / 内容」对。入群问答原文是 `问题：…\n答案：…`，整条塞进一行里
 * 全是文字，看不出层次；拆开后标签走弱化色、内容走正文色。
 * 拆不出来（普通留言）就整条当内容。
 */
const ANSWER_LINE = /^([^：:\n]{1,8})[：:]\s*(.*)$/;

function splitNoticeMessage(message: string): Array<{ label?: string; value: string }> {
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = ANSWER_LINE.exec(line);
      return m?.[2] ? { label: m[1], value: m[2] } : { value: line };
    });
}

/**
 * 群通知灯箱。结构与好友通知一致；保留存疑申请标记（notice-doubt-mark）。
 * 卡片三段：头像 / 正文（申请人+群名+动作、附言问答对）/ 右上角状态徽标 + 时间。
 * 每行 nowrap + 省略号，长群名靠 CSS 截断而不是把时间挤到下一行。
 */
function GroupNoticeDialogBody({
  open,
  requests,
  onClose,
  onOpenProfile,
}: {
  open: boolean;
  requests: GroupJoinRequest[];
  onClose: () => void;
  onOpenProfile?: NoticeProfileHandler;
}) {
  const inbox = useNoticeOperations(true, open);
  const { cards, remaining } = bindNoticeOperations(requests, inbox.operations);
  return (
    <OverlayLayer
      presentation="page"
      title="群通知"
      className="weq-profile-layer weq-notice-layer"
      open={open}
      onClose={onClose}
    >
      <section
        className="weq-notice-dialog weq-anim-pop"
        role="region"
        aria-label="群通知"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <PageShell
          title="群通知"
          icon={<Users size={15} />}
          leading={
            <button
              className="weq-page-back"
              type="button"
              title="返回"
              aria-label="返回"
              onClick={onClose}
            >
              <ArrowLeft size={18} />
            </button>
          }
        >
          <div
            className={cn(
              'weq-notice-scroll',
              requests.length === 0 && remaining.length === 0 && 'is-empty',
            )}
          >
            {inbox.error && <p role="alert">{inbox.error}</p>}
            {requests.length === 0 && remaining.length === 0 ? (
              <EmptyState
                title="暂无群通知"
                body="入群申请和处理结果会显示在这里。"
                icon={<Users />}
              />
            ) : (
              cards.map(({ notice: request, operation }) => {
                const badge = HANDLE_STATE_LABEL[request.handleState];
                const who = displayUserName(request.user);
                const fields = request.message ? splitNoticeMessage(request.message) : [];
                return (
                  <article
                    className={cn('notice-card', 'notice-card-request', badge?.tone)}
                    key={request.id}
                  >
                    <NoticeAvatar
                      user={request.user}
                      group={{ code: request.group.id, name: request.group.name }}
                      onOpenProfile={onOpenProfile}
                    />
                    <div className={cn('notice-copy')}>
                      <p className="notice-line-head">
                        <span className="notice-who" title={who}>
                          {who}
                        </span>
                        <span className="notice-action-text">{request.action}</span>
                      </p>
                      <p className="notice-line-group">
                        <span className="notice-group-name" title={request.group.name}>
                          {request.group.name}
                        </span>
                      </p>
                      {fields.length > 0 ? (
                        <dl className="notice-fields">
                          {fields.map((field) => (
                            <div
                              className="notice-field"
                              key={`${field.label ?? ''}${field.value}`}
                            >
                              {field.label ? <dt>{field.label}</dt> : null}
                              <dd title={field.value}>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                      {request.operator ? (
                        <span className="notice-operator">
                          由 {displayUserName(request.operator)} 处理
                          {request.respondedAt
                            ? ` · ${formatProfileDate(request.respondedAt)}`
                            : ''}
                        </span>
                      ) : null}
                      {request.systemRemark ? (
                        <span className="notice-sysremark">{request.systemRemark}</span>
                      ) : null}
                      {open && operation && (
                        <RequestActions
                          key={`${operation.kind}:${operation.token}`}
                          operation={operation}
                        />
                      )}
                    </div>
                    <div className="notice-meta">
                      {badge ? (
                        <em className={cn('notice-state', badge.tone)}>{badge.text}</em>
                      ) : null}
                      <time>{formatProfileDate(request.createdAt)}</time>
                    </div>
                    {request.isDoubt ? <div className={cn('notice-doubt-mark')} /> : null}
                  </article>
                );
              })
            )}
            {open &&
              remaining.map((operation) => (
                <OnlineRequestCard
                  key={`${operation.kind}:${operation.token}`}
                  operation={operation}
                  onOpenProfile={onOpenProfile}
                />
              ))}
          </div>
        </PageShell>
      </section>
    </OverlayLayer>
  );
}

/** 在线收件箱里的新申请尚未同步进本地通知库时，也使用相同卡片。 */
function OnlineRequestCard({
  operation,
  onOpenProfile,
}: {
  operation: NoticeOperation;
  onOpenProfile?: NoticeProfileHandler;
}) {
  const user: User = {
    id: operation.uid,
    username: operation.uid,
    identityLabel: operation.uin ? 'QQ' : 'UID',
    identityValue: operation.uin || operation.uid,
    displayName: operation.name,
    avatarUrl: avatarFromUin(operation.uin),
  };
  return (
    <article className="notice-card notice-card-request is-pending">
      <NoticeAvatar
        user={user}
        group={
          operation.groupId ? { code: operation.groupId, name: operation.groupName } : undefined
        }
        onOpenProfile={onOpenProfile}
      />
      <div className="notice-copy">
        <p className="notice-line-head">
          <span className="notice-who">{operation.name}</span>
          <span className="notice-action-text">
            {operation.groupId ? '申请加入' : '请求加为好友'}
          </span>
        </p>
        {operation.groupName && (
          <p className="notice-line-group">
            <span className="notice-group-name">{operation.groupName}</span>
          </p>
        )}
        <p className="notice-sysremark">{operation.message}</p>
        <RequestActions operation={operation} />
      </div>
      <div className="notice-meta">
        <em className="notice-state is-pending">待处理</em>
      </div>
      {(operation.kind === 'doubtFriend' || operation.kind === 'filteredGroup') && (
        <div className="notice-doubt-mark" />
      )}
    </article>
  );
}

function NoticeAvatar({
  user,
  group,
  onOpenProfile,
}: {
  user: User;
  group?: { code: string; name: string };
  onOpenProfile?: NoticeProfileHandler;
}) {
  const name = displayUserName(user);
  const avatar = <Avatar name={name} avatarUrl={user.avatarUrl} seed={user.identityValue} />;
  if (!onOpenProfile || (!user.id && !user.identityValue)) return avatar;
  return (
    <button
      type="button"
      className="notice-avatar-button"
      title={`查看 ${name} 的名片`}
      aria-label={`查看 ${name} 的名片`}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const anchor =
          event.detail === 0
            ? { x: rect.right, y: rect.bottom }
            : { x: event.clientX, y: event.clientY };
        onOpenProfile(user, anchor, group);
      }}
    >
      {avatar}
    </button>
  );
}

export const ContactNoticeDialog = withQQAccountScope(ContactNoticeDialogBody);
export const GroupNoticeDialog = withQQAccountScope(GroupNoticeDialogBody);
