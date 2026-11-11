import { useId, useState } from 'react';
import { ChevronRight, ContactRound, RotateCcw, X } from 'lucide-react';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { useTabActive } from './RetainedTabs';
import '../styles/profile-extras.css';

type Target = QQWriteBinding & { uin: string };
const fields = [
  { key: 'company', label: '公司' },
  { key: 'personalDescription', label: '个人说明' },
  { key: 'email', label: '邮箱' },
] as const;
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
            <Details input={input} online={online} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
function Details({ input, online }: { input: Target; online: boolean }) {
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
  const error = query.error || (query.data && !usable ? new Error('详细资料目标不匹配') : null);
  return (
    <>
      <div className="weq-education-refresh">
        {usable && error ? <span role="status">刷新失败，已显示的资料保留。</span> : null}
        <button
          type="button"
          className="weq-extras-back"
          aria-label="重新读取详细资料"
          disabled={!online || query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RotateCcw size={14} />
          {query.isFetching ? '读取中…' : error ? '重试' : '刷新'}
        </button>
      </div>
      {!usable ? (
        <div className="weq-extras-status" role="status">
          {!online
            ? '暂不可在线读取'
            : query.isFetching
              ? '读取中…'
              : error
                ? '读取失败，请重试'
                : '尚未返回详细资料'}
        </div>
      ) : (
        <div className="weq-extras-list weq-profile-details-list">
          {fields.map(({ key, label }) => (
            <article key={key}>
              <h3>{label}</h3>
              {usable.errors[key] ? (
                <p role="alert">{usable.errors[key]}</p>
              ) : (
                <p>
                  {usable[key] === null ? '未返回' : usable[key] === '' ? '未填写' : usable[key]}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
