import type { ProfileSimilarity } from '@weqbot/protocol';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { trpc } from '../trpc/client';
import { useTabActive } from './RetainedTabs.shared';
import { ContactInlineError, ContactRow } from './contactProfile/ContactRow';
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
export function ProfileCommonPoints({ uin }: { uin: string }) {
  const { input, enabled, online } = useSummaryTarget(uin);
  const query = trpc.account.profileExtras.similarity.useQuery(input, { ...options, enabled });
  const data = query.data?.targetUin === uin ? query.data : null;
  const mismatch = query.data && !data ? new Error('资料目标不匹配') : null;
  return (
    <>
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
    </>
  );
}
export function CommonPointRows({ data }: { data: ProfileSimilarity }) {
  const items = [...new Map(data.items.map((item) => [JSON.stringify(item), item])).entries()];
  return items.length ? (
    <div className="weq-profile-data weq-profile-common-points" data-privacy-sensitive>
      {items.map(([key, item]) => (
        <ContactRow
          key={key}
          label={item.title || '资料对比'}
          icon={item.icon ? <ShimmerImage src={collectionImageUrl(item.icon)} alt="" /> : undefined}
        >
          <p>{item.wordings.join('\n')}</p>
        </ContactRow>
      ))}
    </div>
  ) : (
    <p role="status" className="text-muted-foreground">
      暂无可展示的资料对比
    </p>
  );
}
