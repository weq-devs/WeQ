import { beijingDay } from '../../lib/messageCalendar';
import type { ConversationRecordHit } from './types';

export function recordDay(seconds: string | number | undefined): string {
  const time = Number(seconds);
  return time > 0 && time < 253402272000 ? beijingDay(new Date(time * 1000)) : '';
}

export function groupRecordDays(messages: ConversationRecordHit[]) {
  const days = new Map<string, ConversationRecordHit[]>();
  for (const message of messages) {
    const day = recordDay(message.sendTime);
    const rows = days.get(day);
    if (rows) rows.push(message);
    else days.set(day, [message]);
  }
  return days;
}
