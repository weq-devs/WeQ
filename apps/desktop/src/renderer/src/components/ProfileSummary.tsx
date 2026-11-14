import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ProfileMedalWall, ProfileSimilarity } from '@weq/protocol';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { trpc } from '../trpc/client';
import { useTabActive } from './RetainedTabs';
import { ContactInlineError, ContactRow, ContactSection } from './contactProfile/ContactRow';
import { openExternalLink } from '../lib/openExternalLink';
import { collectionImageUrl } from '../lib/resourceUrl';
import { ShimmerImage } from './ShimmerImage';
import '../styles/profile-summary.css';

const options = {
  staleTime: 5 * 60_000,
  cacheTime: 5 * 60_000,
  retry: false as const,
  refetchOnWindowFocus: false,
  refetchOnMount: true,
};
function useSummaryTarget(uin: string) {
  const session = useQQWriteSession(`profile-summary:${uin}`, true);
  const active = useTabActive();
  return {
    input: {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      uin,
    },
    online: session.available,
    enabled: active && session.available,
  };
}
function SummaryStatus({
  online,
  fetching,
  error,
  hasData,
  retry,
}: {
  online: boolean;
  fetching: boolean;
  error: unknown;
  hasData: boolean;
  retry: () => unknown;
}) {
  if (error && online)
    return (
      <ContactInlineError
        message={hasData ? '刷新失败，已有内容保留。' : '资料读取失败，请重试。'}
        onRetry={() => void retry()}
        retrying={fetching}
      />
    );
  return (
    <p role="status" className="text-muted-foreground">
      {!online ? '暂不可在线读取' : fetching ? '读取中…' : '未返回资料'}
    </p>
  );
}
export function MedalWall({ uin }: { uin: string }) {
  const { input, enabled, online } = useSummaryTarget(uin);
  const query = trpc.account.profileExtras.medalWall.useQuery(input, { ...options, enabled });
  const data = query.data?.targetUin === uin ? query.data : null;
  const mismatch = query.data && !data ? new Error('资料目标不匹配') : null;
  const [linkError, setLinkError] = useState<string | null>(null);
  return (
    <div data-privacy-sensitive>
      {data ? <MedalWallRows data={data} /> : null}
      {!data || query.error || mismatch ? (
        <SummaryStatus
          online={online}
          fetching={query.isFetching}
          error={query.error || mismatch}
          hasData={Boolean(data)}
          retry={query.refetch}
        />
      ) : null}
      {data ? (
        <button
          type="button"
          className="weq-profile-medal-link"
          onClick={async () => {
            const result = await openExternalLink(data.detailsUrl);
            setLinkError(result.ok ? null : (result.error ?? '勋章墙详情打开失败'));
          }}
        >
          <ExternalLink size={14} />
          查看 QQ 勋章墙详情
        </button>
      ) : null}
      {linkError ? <p role="alert">{linkError}</p> : null}
    </div>
  );
}
export function MedalWallRows({ data }: { data: ProfileMedalWall }) {
  return (
    <div className="weq-profile-data">
      <ContactRow label="勋章数量" value={data.count === null ? '未返回' : `${data.count} 枚`} />
      <ContactRow
        label="展示状态"
        value={data.openFlag === 0 ? '已开启' : data.openFlag === 1 ? '已关闭' : null}
      />
      <ContactRow label="新获勋章" value={data.newCount === null ? null : `${data.newCount} 枚`} />
      <ContactRow
        label="升级勋章"
        value={data.upgradeCount === null ? null : `${data.upgradeCount} 枚`}
      />
    </div>
  );
}
export function ProfileCommonPoints({ uin }: { uin: string }) {
  const { input, enabled, online } = useSummaryTarget(uin);
  const query = trpc.account.profileExtras.similarity.useQuery(input, { ...options, enabled });
  const data = query.data?.targetUin === uin ? query.data : null;
  const mismatch = query.data && !data ? new Error('资料目标不匹配') : null;
  return (
    <ContactSection title="共同点" prominent>
      {data ? <CommonPointRows data={data} /> : null}
      {!data || query.error || mismatch ? (
        <SummaryStatus
          online={online}
          fetching={query.isFetching}
          error={query.error || mismatch}
          hasData={Boolean(data)}
          retry={query.refetch}
        />
      ) : null}
    </ContactSection>
  );
}
export function CommonPointRows({ data }: { data: ProfileSimilarity }) {
  const items = [...new Map(data.items.map((item) => [JSON.stringify(item), item])).entries()];
  return items.length ? (
    <div className="weq-profile-data weq-profile-common-points" data-privacy-sensitive>
      {items.map(([key, item]) => (
        <ContactRow
          key={key}
          label={item.title || '共同点'}
          icon={item.icon ? <ShimmerImage src={collectionImageUrl(item.icon)} alt="" /> : undefined}
        >
          <p>{item.wordings.join('\n')}</p>
        </ContactRow>
      ))}
    </div>
  ) : (
    <p role="status" className="text-muted-foreground">
      暂无可展示的共同点
    </p>
  );
}
