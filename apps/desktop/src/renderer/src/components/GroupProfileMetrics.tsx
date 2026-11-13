import type { ReactNode } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useTabActive } from './RetainedTabs';
import { GROUP_SORTS, metricValue } from '../lib/contactListOrder';

type MetricRows = Array<readonly [string, string]>;
type Props = { groupCode: string; children: (rows: MetricRows) => ReactNode };
const METRICS = ['activityScore', 'friendCount'] as const;

/**
 * 只读排序所用的账号缓存，不因打开资料触发在线更新。
 * 没有可信缓存时不出行——不用「未知」占位（设计契约 §3）。
 */
export function GroupProfileMetrics(props: Props) {
  const uin = useViewState((state) => state.openedUin);
  return uin ? <AccountMetrics key={uin} {...props} uin={uin} /> : props.children([]);
}

function AccountMetrics({ groupCode, children, uin }: Props & { uin: string }) {
  const active = useTabActive();
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: active });
  const configId = config.data?.uin === uin ? config.data.configId : undefined;
  const binding = { expectedAccountUin: uin, expectedAccountConfigId: configId ?? '' };
  const enabled = active && Boolean(configId);
  const snapshot = trpc.account.contactMetrics.snapshot.useQuery(binding, {
    enabled,
    staleTime: 5000,
    keepPreviousData: false,
  });
  const utils = trpc.useUtils();
  trpc.account.contactMetrics.changed.useSubscription(binding, {
    enabled,
    onData: () => void utils.account.contactMetrics.snapshot.invalidate(binding),
  });
  const rows = METRICS.flatMap((metric) => {
    const value = configId
      ? metricValue(snapshot.data?.rows ?? {}, `group:${groupCode}`, metric)
      : null;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? ([[GROUP_SORTS[metric], String(value)]] as MetricRows)
      : [];
  });
  return children(rows);
}
