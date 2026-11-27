import { occupationText } from '@weqbot/protocol/profile-values';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { educationDegree, educationRows } from '../../lib/profileEducation';
import { useTabActive } from '../RetainedTabs.shared';
import { ContactInlineError, ContactRow } from './ContactRow';

function useTarget(uin: string) {
  const session = useQQWriteSession(`contact-details:${uin}`, true);
  const active = useTabActive();
  return {
    input: {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      uin,
    },
    enabled: active && session.available,
  };
}
function useDetails(uin: string) {
  const target = useTarget(uin);
  const query = trpc.account.profileExtras.details.useQuery(target.input, {
    ...PROFILE_QUERY_OPTIONS,
    enabled: target.enabled,
  });
  const data = query.data?.targetUin === uin ? query.data : null;
  return {
    ...target,
    ...query,
    usable: data,
    failure: query.error || (query.data && !data ? new Error('资料目标不匹配') : null),
  };
}
function ReadState({
  label,
  enabled,
  fetching,
  error,
  retry,
}: {
  label: string;
  enabled: boolean;
  fetching: boolean;
  error: unknown;
  retry: () => unknown;
}) {
  if (!enabled) return null;
  if (fetching) return <ContactRow label={label} value="读取中…" />;
  if (error)
    return (
      <ContactRow label={label}>
        <ContactInlineError message="读取失败" onRetry={() => void retry()} retrying={fetching} />
      </ContactRow>
    );
  return null;
}
export function ContactOnlineOccupation({ uin }: { uin: string }) {
  const query = useDetails(uin);
  const value = occupationText(query.usable?.profession);
  return value ? (
    <ContactRow label="职业" value={value} />
  ) : (
    <ReadState
      label="职业"
      enabled={query.enabled}
      fetching={query.isFetching}
      error={query.failure || query.usable?.errors.profession}
      retry={query.refetch}
    />
  );
}
export function ContactOnlineRegion({ uin }: { uin: string }) {
  const target = useTarget(uin);
  const query = trpc.account.profileExtras.region.useQuery(target.input, {
    ...PROFILE_QUERY_OPTIONS,
    enabled: target.enabled,
  });
  const data = query.data?.targetUin === uin ? query.data : null;
  return data?.regionText ? (
    <ContactRow label="所在地" value={data.regionText} />
  ) : (
    <ReadState
      label="所在地"
      enabled={target.enabled}
      fetching={query.isFetching}
      error={query.error || (query.data && !data ? new Error('资料目标不匹配') : null)}
      retry={query.refetch}
    />
  );
}
export function ContactOnlineSchool({
  uin,
  cachedDegree,
  onOpen,
}: {
  uin: string;
  cachedDegree?: string;
  onOpen: (anchor: HTMLElement) => void;
}) {
  const details = useDetails(uin);
  const legacySchool = details.usable?.school?.trim();
  const education = trpc.account.profileExtras.educationHistory.useQuery(details.input, {
    ...PROFILE_QUERY_OPTIONS,
    enabled:
      details.enabled && !legacySchool && (details.data !== undefined || Boolean(details.failure)),
  });
  const history = education.data?.targetUin === uin ? education.data : null;
  const record = educationRows(history?.items ?? [], false).find((row) =>
    row.record.schoolName?.trim(),
  )?.record;
  const degree = cachedDegree?.trim();
  const value = legacySchool
    ? [legacySchool, degree].filter(Boolean).join(' · ')
    : record
      ? [record.schoolName?.trim(), degree || educationDegree(record.degree)]
          .filter(Boolean)
          .join(' · ')
      : degree;
  if (value)
    return (
      <ContactRow label="学校" value={value} onActivate={onOpen} activateTitle="查看教育经历" />
    );
  return (
    <ReadState
      label="学校"
      enabled={details.enabled}
      fetching={details.isFetching || education.isFetching}
      error={
        education.error ||
        (education.data && !history ? new Error('教育经历目标不匹配') : null) ||
        details.failure ||
        details.usable?.errors.school
      }
      retry={() => Promise.all([details.refetch(), education.refetch()])}
    />
  );
}
