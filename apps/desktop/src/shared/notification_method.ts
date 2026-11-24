import { z } from 'zod/v3';
import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationEvents,
  type NotificationEventOverrides,
} from '@weq/service/notification-settings';

export const NOTIFICATION_METHODS = [
  { value: 'off', label: '不通知', channels: { banner: false, system: false } },
  { value: 'banner', label: '仅应用内横幅', channels: { banner: true, system: false } },
  { value: 'system', label: '仅系统通知', channels: { banner: false, system: true } },
  { value: 'both', label: '应用内横幅与系统通知', channels: { banner: true, system: true } },
] as const;
export type NotificationMethod = (typeof NOTIFICATION_METHODS)[number]['value'];

export function notificationMethodOf(
  channels: NotificationEvents[NotificationEvent],
): NotificationMethod {
  return channels.banner
    ? channels.system
      ? 'both'
      : 'banner'
    : channels.system
      ? 'system'
      : 'off';
}

export const notificationEventUpdateInput = z
  .object({
    events: z
      .array(
        z.custom<NotificationEvent>(
          (value) =>
            typeof value === 'string' && NOTIFICATION_EVENTS.includes(value as NotificationEvent),
        ),
      )
      .min(1)
      .max(NOTIFICATION_EVENTS.length),
  })
  .and(
    z.union([
      z.object({ channel: z.enum(['banner', 'system']), enabled: z.boolean() }),
      z.object({ channels: z.object({ banner: z.boolean(), system: z.boolean() }) }),
    ]),
  );

export function notificationEventPatch(
  current: NotificationEvents,
  input: z.infer<typeof notificationEventUpdateInput>,
): NotificationEventOverrides {
  return Object.fromEntries(
    input.events.map((event) => [
      event,
      'channels' in input
        ? { ...input.channels }
        : { ...current[event], [input.channel]: input.enabled },
    ]),
  );
}
