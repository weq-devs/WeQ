import { useId, useState } from 'react';
import { ChevronRight, ContactRound, RotateCcw, X } from 'lucide-react';
import type { ProfileDetailInfo } from '@weq/protocol';
import { useQQWriteSession, type QQWriteBinding } from '../hooks/useQQWriteSession';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { useTabActive } from './RetainedTabs';
import { ContactInlineError, ContactRow, ContactSection } from './contactProfile/ContactRow';
import '../styles/profile-extras.css';

type Target = QQWriteBinding & { uin: string };
const fields = [
  { key: 'company', label: '公司' },
  { key: 'personalDescription', label: '个人说明' },
  { key: 'email', label: '邮箱' },
] as const;

/**
 * 详细资料（公司 / 个人说明 / 邮箱）的唯一行模型。
 *
 * 资料页与快速名片里的「详细资料」弹窗共用 `ContactRow`：label 固定列、值左对齐；
 * 读取状态与重试走正文内联提示，不再自带一套 label 在上方的卡片版式或浮动刷新条。
 */
type DetailsQuery = {
  usable: ProfileDetailInfo | null;
  error: unknown;
  fetching: boolean;
  refetch: () => unknown;
};

function useProfileDetails(input: Target, online: boolean): DetailsQuery {
  const active = useTabActive();
  const query = trpc.account.profileExtras.details.useQuery(input, {
    enabled: online && active,
    staleTime: 5 * 60_000,
    cacheTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });
  const usable = query.data?.targetUin === input.uin ? query.data : null;
  return {
    usable,
    error: query.error || (query.data && !usable ? new Error('详细资料目标不匹配') : null),
    fetching: query.isFetching,
    refetch: query.refetch,
  };
}

function statusText({ usable, error, fetching }: DetailsQuery, online: boolean) {
  if (!online) return '暂不可在线读取';
  if (fetching) return '读取中…';
  if (error) return '读取失败，请重试';
  return usable ? '' : '尚未返回详细资料';
}

/** 三项资料始终按行展示：未返回、未填写和单项解析失败各自有明确文案。 */
function DetailsRows({ info }: { info: ProfileDetailInfo }) {
  return (
    <div className="weq-profile-data">
      {fields.map(({ key, label }) => {
        const value = info.errors[key]
          ? info.errors[key]
          : info[key] === null
            ? '未返回'
            : info[key] === ''
              ? '未填写'
              : info[key];
        return <ContactRow key={key} label={label} value={value} />;
      })}
    </div>
  );
}

function DetailsContent({ details, online }: { details: DetailsQuery; online: boolean }) {
  if (!details.usable) {
    return (
      <p className="weq-extras-status" role="status">
        {statusText(details, online)}
      </p>
    );
  }
  return (
    <>
      <DetailsRows info={details.usable} />
      {details.error ? (
        <ContactInlineError
          message="刷新失败，已显示的资料保留。"
          onRetry={() => void details.refetch()}
          retrying={details.fetching}
        />
      ) : null}
    </>
  );
}

export function ProfileDetailsEntry({ input, online }: { input: Target; online: boolean }) {
  return (
    <Entry
      key={`${input.expectedAccountUin}:${input.expectedAccountConfigId}:${input.uin}`}
      input={input}
      online={online}
    />
  );
}

function Entry({ input, online }: { input: Target; online: boolean }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <>
      <button type="button" title="查看公司、个人说明和邮箱" onClick={() => setOpen(true)}>
        <ContactRound size={15} />
        详细资料
        <ChevronRight size={14} />
      </button>
      {open ? (
        <Modal
          onClose={() => setOpen(false)}
          labelledBy={titleId}
          width={680}
          className="weq-extras-dialog"
        >
          <header className="weq-extras-header">
            <h2 id={titleId}>详细资料</h2>
            <button
              type="button"
              title="关闭"
              aria-label="关闭详细资料"
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </header>
          <div className="weq-extras-content" data-privacy-sensitive>
            <ProfileDetailsContent input={input} online={online} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/** 弹窗内容：只输出统一数据行与内联状态，不额外画卡片或刷新条。 */
export function ProfileDetailsContent({ input, online }: { input: Target; online: boolean }) {
  const details = useProfileDetails(input, online);
  return <DetailsContent details={details} online={online} />;
}

/** 资料页「扩展资料」分区：数据为空且无错误时不占位；有内容时分区标题右侧提供刷新。 */
export function ProfileDetailsSection({ uin }: { uin: string }) {
  const session = useQQWriteSession(`profile-extras:${uin}`);
  const input = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    uin,
  };
  const details = useProfileDetails(input, session.available);
  if (!details.usable && !details.error) return null;
  return (
    <ContactSection
      title="扩展资料"
      action={
        details.usable ? (
          <button
            type="button"
            className="weq-profile-section-action"
            title="重新读取扩展资料"
            disabled={!session.available || details.fetching}
            onClick={() => void details.refetch()}
          >
            <RotateCcw size={12} />
            {details.fetching ? '读取中…' : '刷新'}
          </button>
        ) : undefined
      }
    >
      {details.usable ? <DetailsRows info={details.usable} /> : null}
      {details.error ? (
        <ContactInlineError
          message={details.usable ? '刷新失败，已显示的资料保留。' : '扩展资料读取失败'}
          onRetry={() => void details.refetch()}
          retrying={details.fetching}
        />
      ) : null}
    </ContactSection>
  );
}
