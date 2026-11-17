import { formatDateTimeInput, parseDateTimeInput } from '@weq/time';
import '../../styles/composition-time.css';

export const MAX_MESSAGE_TIME = 0xffff_ffff;

export function nodeTimeValue(seconds: number): string {
  return formatDateTimeInput(seconds * 1000);
}

export function parseNodeTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const ms = parseDateTimeInput(value);
  const seconds = ms === null ? null : ms / 1000;
  return seconds !== null &&
    Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= MAX_MESSAGE_TIME
    ? seconds
    : null;
}
