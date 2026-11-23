import { dateFormatter } from '@weq/time';
export { groupCreationDate as formatShortDate } from '../../components/groupProfile/GroupContent.shared';

export function formatProfileDate(value: string) {
  return dateFormatter.format(value);
}
