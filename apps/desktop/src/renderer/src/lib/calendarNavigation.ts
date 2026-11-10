import { createContext } from 'react';
import type { CalendarAnchor, CalendarTarget } from '@weq/service/conversation-calendar';
import type { client } from '../trpc/client';

export type CalendarLocated = Awaited<
  ReturnType<typeof client.account.calendarOverview.locate.mutate>
>;
export type CalendarNavigate = (
  target: CalendarTarget,
  anchor: CalendarAnchor,
  record?: CalendarLocated['record'],
) => void;
export const CalendarNavigationContext = createContext<CalendarNavigate | null>(null);
