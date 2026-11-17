import { formatDateTime, timeDate } from '@weq/time';

export function groupCreationDate(value?: string | null) {
  const date = timeDate(value);
  return date && date.getTime() > 0 ? formatDateTime(value) : '';
}
