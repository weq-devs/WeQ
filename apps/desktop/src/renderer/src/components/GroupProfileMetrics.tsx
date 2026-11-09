import type { ReactNode } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useTabActive } from './RetainedTabs';
import { GROUP_SORTS, metricValue } from '../lib/contactListOrder';

type MetricRows = Array<readonly [string, string]>;
type Props = { groupCode: string; children: (rows: MetricRows) => ReactNode };
const METRICS = ['activityScore', 'friendCount'] as const;
const UNKNOWN_ROWS: MetricRows = METRICS.map((metric) => [GROUP_SORTS[metric], '未知']);

/** 只读排序所用的账号缓存，不因打开资料触发在线更新。 */
export function GroupProfileMetrics(props: Props) {
  const uin = useViewState((state) => state.openedUin);
  return uin ? <AccountMetrics key={uin} {...props} uin={uin} /> : props.children(UNKNOWN_ROWS);
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
  const rows = METRICS.map((metric) => {
    const value = configId
      ? metricValue(snapshot.data?.rows ?? {}, `group:${groupCode}`, metric)
      : null;
    return [
      GROUP_SORTS[metric],
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '未知',
    ] as const;
  });
  return children(rows);
}
