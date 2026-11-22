import type { PublicJson } from '../lib/qzonePublic';
import { QzoneCardMore } from './QzoneCardMore';
import { useQQAction } from './qq-actions/shared.shared';
import { useQzoneShareCard } from './useQzoneShareCard';

/** Use the original share resource for feeds that do not have an ordinary post ID. */
export function QzoneFeedShareMenu({
  selfUin,
  feed,
  feedKey,
}: {
  selfUin: string;
  feed: PublicJson;
  feedKey: string;
}) {
  const session = useQQAction(`qzone-share:${feedKey}`, 'failure-only', { passive: true });
  const binding =
    session.available && session.binding?.expectedAccountUin === selfUin ? session.binding : null;
  const share = useQzoneShareCard(binding, { feed }, feedKey);
  return (
    <>
      {share.action ? <QzoneCardMore actions={[share.action]} /> : null}
      {share.dialog}
    </>
  );
}
