import { useEffect, useMemo, useRef } from 'react';
import { NEW_CONV_FRESH_SEC } from '@weq/service/live-message';
import { plainContentText, type PlainElement } from '@weq/service/message-plain-text';
import { client } from '../trpc/client';
import {
  accountBinding,
  isAccountStateReady,
  preferenceValue,
  sharedAccountRecords,
  useClientPreferences,
} from '../lib/clientPreferences';
import { useAppLock } from '../state/lock';
import { IS_WEB } from '../lib/target.shared';
import { defaultConversationPreference } from '../im-template/template/preferences';
import type { Conversation, ConversationPreferences } from '../im-template/template/types';
import type { ChatMsgWire } from '../../../main/ipc/serde';
import type { NewMessagesWire } from '../../../main/ipc/routers/account';
import type { WebNotice } from '../../../main/web/notices';
import { ordinaryNoticeEligible } from '../../../shared/message_notifications';
import { WEB_NOTICE_OPEN, browserNoticeChannel } from '../lib/browserNotifications';
import { useNotificationPolicy, claimMessageBanner } from '../lib/notificationPolicy';
import {
  normalizeNotificationScope,
  normalizeNotificationEvents,
  type NotificationEvent,
} from '@weq/service/notification-settings';
import { useToast } from '../components/Toast.shared';

function firstNoticeMessage(previous: ChatMsgWire | undefined, next: ChatMsgWire): ChatMsgWire {
  if (!previous || !/^[1-9]\d*$/.test(previous.msgSeq)) return next;
  return !/^[1-9]\d*$/.test(next.msgSeq) || BigInt(previous.msgSeq) <= BigInt(next.msgSeq)
    ? previous
    : next;
}

export function useMessageNotifications(options: {
  selfUin: string;
  selfUid?: string;
  conversations: Conversation[];
  preferences: ConversationPreferences;
  badgeCount: number;
  foregroundConversation?: string;
  groupAssistantIds?: ReadonlySet<string>;
  resolveGroupSenderName?: (message: ChatMsgWire) => string | Promise<string>;
}) {
  useClientPreferences((state) => state.tick);
  const locked = useAppLock((state) => state.locked);
  const policy = useNotificationPolicy();
  const notificationEvents = policy.ready
    ? policy.events
    : normalizeNotificationEvents(undefined, {
        messageNotifications: preferenceValue('messageNotifications'),
      });
  const enabled = (
    [
      'directMessage',
      'groupMessage',
      'specialCare',
      'mentionMe',
      'mentionAll',
      'replyMe',
      'redPacket',
    ] as const
  ).some((event) => notificationEvents[event].banner || notificationEvents[event].system);
  const badge = preferenceValue('applicationBadge');
  const privacy = preferenceValue('privacyMode') || locked;
  const binding = accountBinding();
  const scopeKey = binding?.expectedAccountUin === options.selfUin ? JSON.stringify(binding) : '';
  const latest = useRef({ ...options, enabled, privacy });
  latest.current = { ...options, enabled, privacy };
  const policies = useMemo(
    () =>
      new Map(
        (enabled ? options.conversations : []).flatMap((conversation) => {
          if (conversation.type !== 'direct' && conversation.type !== 'group') return [];
          const preference = {
            ...defaultConversationPreference,
            ...conversation.preference,
            ...options.preferences[conversation.id],
          };
          return [
            [
              `${conversation.type === 'group' ? 'group' : 'c2c'}:${conversation.id}`,
              {
                muted: Boolean(
                  preference.muted ||
                    (conversation.type === 'group' &&
                      options.groupAssistantIds?.has(conversation.id)),
                ),
                name:
                  conversation.type === 'group'
                    ? conversation.group.name
                    : conversation.otherUser.displayName,
                highlights: conversation.highlights,
              },
            ] as const,
          ];
        }),
      ),
    [enabled, options.conversations, options.preferences, options.groupAssistantIds],
  );
  const policyRef = useRef(policies);
  policyRef.current = policies;
  const seen = useRef(new Set<string>());
  const pending = useRef(new Map<string, { message: ChatMsgWire; observedAt: number }>());
  const openedAt = useRef(Date.now() / 1000);
  const generation = useRef(0);
  const channel = useRef<ReturnType<typeof browserNoticeChannel> | null>(null);
  if (!channel.current) channel.current = browserNoticeChannel();
  const process = useRef<(batch?: NewMessagesWire) => void>(() => undefined);
  process.current = (batch) => {
    const scope = accountBinding();
    if (!scope || JSON.stringify(scope) !== scopeKey || !latest.current.enabled) return;
    if (
      batch &&
      ((batch.accountUin && batch.accountUin !== scope.expectedAccountUin) ||
        (batch.configId && batch.configId !== scope.expectedAccountConfigId))
    )
      return;
    for (const message of batch?.messages ?? [])
      pending.current.set(JSON.stringify([message.kind, message.conv, message.msgId]), {
        message,
        observedAt: (batch?.observedAt ?? Date.now()) / 1000,
      });
    const notices = new Map<
      string,
      {
        message: ChatMsgWire;
        anchor: ChatMsgWire;
        title: string;
        body: string;
        count: number;
        reasons: NotificationEvent[];
        anchors: Map<NotificationEvent, ChatMsgWire>;
      }
    >();
    for (const [key, { message, observedAt }] of pending.current) {
      if (seen.current.has(key)) {
        pending.current.delete(key);
        continue;
      }
      const policy = policyRef.current.get(`${message.kind}:${message.conv}`);
      if (!policy) continue;
      pending.current.delete(key);
      seen.current.add(key);
      const reading =
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        latest.current.foregroundConversation === message.conv;
      if (
        !ordinaryNoticeEligible(message, {
          selfUin: options.selfUin,
          selfUid: options.selfUid,
          openedAt: openedAt.current,
          observedAt,
          freshSeconds: NEW_CONV_FRESH_SEC,
          muted: policy.muted,
          reading,
        })
      )
        continue;
      const elements = message.elements.filter((element): element is PlainElement =>
        Boolean(element && typeof element === 'object'),
      );
      if (elements.length > 0 && elements.every((element) => /^grayTip/i.test(element.type ?? '')))
        continue;
      const convKey = `${message.kind}:${message.conv}`;
      const reasons: NotificationEvent[] = [
        message.kind === 'group' ? 'groupMessage' : 'directMessage',
      ];
      const mapping = {
        atMe: 'mentionMe',
        atAll: 'mentionAll',
        replyMe: 'replyMe',
        specialCare: 'specialCare',
        redPacket: 'redPacket',
      } as const;
      for (const highlight of policy.highlights ?? []) {
        if (highlight.msgSeq !== message.msgSeq || !(highlight.kind in mapping)) continue;
        const event = mapping[highlight.kind as keyof typeof mapping];
        if (event !== 'specialCare') {
          if (!isAccountStateReady()) continue;
          const selection = normalizeNotificationScope(
            event,
            sharedAccountRecords('notifications')[event],
          );
          if (selection.mode !== 'all' && !selection.targets.includes(convKey)) continue;
        }
        reasons.push(event);
      }
      const previous = notices.get(convKey);
      const anchor = firstNoticeMessage(previous?.anchor, message);
      const anchors = previous?.anchors ?? new Map<NotificationEvent, ChatMsgWire>();
      for (const reason of reasons)
        anchors.set(reason, firstNoticeMessage(anchors.get(reason), message));
      notices.set(convKey, {
        message,
        anchor,
        anchors,
        title: policy.name || message.conv,
        body: plainContentText(elements).slice(0, 1700) || '[消息]',
        count: (notices.get(convKey)?.count ?? 0) + 1,
        reasons: [...new Set([...(previous?.reasons ?? []), ...reasons])],
      });
    }
    while (seen.current.size > 5000) seen.current.delete(seen.current.values().next().value!);
    while (pending.current.size > 500) pending.current.delete(pending.current.keys().next().value!);
    for (const item of notices.values()) {
      const currentGeneration = generation.current;
      const show = (senderName = '') => {
        if (
          generation.current !== currentGeneration ||
          JSON.stringify(accountBinding()) !== scopeKey ||
          !latest.current.enabled ||
          (document.visibilityState === 'visible' &&
            document.hasFocus() &&
            latest.current.foregroundConversation === item.message.conv)
        )
          return;
        const sender =
          senderName.trim() ||
          (item.message.senderUin && item.message.senderUin !== '0'
            ? item.message.senderUin
            : item.message.senderUid || '成员');
        const content =
          item.message.kind === 'group' ? `${sender.slice(0, 256)}：${item.body}` : item.body;
        const title = latest.current.privacy ? 'WeQ' : item.title.slice(0, 512);
        const body = latest.current.privacy
          ? '收到新消息'
          : content + (item.count > 1 ? `\n另有 ${item.count - 1} 条消息` : '');
        const notice: WebNotice = {
          uin: scope.expectedAccountUin,
          configId: scope.expectedAccountConfigId,
          kind: 'message',
          title,
          body,
        };
        const currentPolicyState = useNotificationPolicy.getState();
        const currentPolicy = currentPolicyState.ready
          ? currentPolicyState.events
          : normalizeNotificationEvents(undefined, {
              messageNotifications: preferenceValue('messageNotifications'),
            });
        const noticeFor = (channel: 'banner' | 'system') => {
          let anchor: ChatMsgWire | undefined;
          for (const [reason, candidate] of item.anchors) {
            if (currentPolicy[reason][channel]) anchor = firstNoticeMessage(anchor, candidate);
          }
          anchor ??= item.anchor;
          return {
            ...notice,
            target: {
              kind: item.message.kind,
              conv: item.message.conv,
              seq: anchor.msgSeq,
              msgId: anchor.msgId,
            },
          };
        };
        const bannerNotice = noticeFor('banner');
        const systemNotice = noticeFor('system');
        if (
          item.reasons.some((event) => currentPolicy[event].banner) &&
          (item.message.kind !== 'group' ||
            claimMessageBanner(
              scope.expectedAccountConfigId,
              item.message.kind,
              item.message.conv,
              item.message.msgSeq,
            ))
        )
          useToast.getState().push({
            event: item.reasons.find((event) => currentPolicy[event].banner),
            title,
            detail: body,
            action: {
              label: '定位消息',
              run: () =>
                window.dispatchEvent(new CustomEvent(WEB_NOTICE_OPEN, { detail: bannerNotice })),
            },
          });
        if (!item.reasons.some((event) => currentPolicy[event].system)) return;
        if (IS_WEB) {
          channel.current?.show(systemNotice);
        } else
          void client.account.messageNotifications.notify
            .mutate({
              ...scope,
              messageId: item.message.msgId,
              anchorId: systemNotice.target.msgId,
              kind: item.message.kind,
              conv: item.message.conv,
              seq: systemNotice.target.seq,
              title,
              body,
              private: latest.current.privacy,
              reasons: item.reasons,
            })
            .catch((error: unknown) => console.warn('[message-notifications] 通知未提交', error));
      };
      const resolve = latest.current.resolveGroupSenderName;
      if (item.message.kind === 'group' && !latest.current.privacy && resolve) {
        void (async () => {
          let senderName = '';
          try {
            senderName = await resolve(item.message);
          } catch (error) {
            console.warn('[message-notifications] 发送者名称未补全', error);
          }
          show(senderName);
        })();
      } else show();
    }
  };
  useEffect(() => {
    seen.current.clear();
    pending.current.clear();
    openedAt.current = Date.now() / 1000;
    if (!scopeKey || !enabled) return;
    const subscription = client.account.onNewMessages.subscribe(undefined, {
      onData: (batch) => process.current(batch),
    });
    return () => {
      generation.current++;
      subscription.unsubscribe();
      channel.current?.close();
    };
  }, [scopeKey, enabled]);
  useEffect(() => {
    process.current();
  }, [policies]);
  useEffect(() => {
    const scope = accountBinding();
    if (!scopeKey || !scope) return;
    const count = badge ? options.badgeCount : 0;
    if (IS_WEB) {
      const browser = navigator as Navigator & {
        setAppBadge?: (count: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      const work = count ? browser.setAppBadge?.(count) : browser.clearAppBadge?.();
      void work?.catch((error: unknown) =>
        console.warn('[message-notifications] 浏览器角标不可用', error),
      );
    } else
      void client.account.messageNotifications.badge
        .mutate({ ...scope, count })
        .catch((error: unknown) => console.warn('[message-notifications] 角标未更新', error));
  }, [scopeKey, badge, options.badgeCount]);
  useEffect(() => {
    if (!IS_WEB || !scopeKey) return;
    return () => {
      const browser = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      void browser
        .clearAppBadge?.()
        .catch((error: unknown) => console.warn('[message-notifications] 浏览器角标未清除', error));
    };
  }, [scopeKey]);
  useEffect(() => {
    const scope = accountBinding();
    if (IS_WEB || !scopeKey || !scope) return;
    let active = true;
    const consume = () =>
      void client.account.messageNotifications.consume
        .mutate(scope)
        .then((notice) => {
          if (notice && active && JSON.stringify(accountBinding()) === scopeKey)
            window.dispatchEvent(new CustomEvent(WEB_NOTICE_OPEN, { detail: notice }));
        })
        .catch((error: unknown) => console.warn('[message-notifications] 通知定位未接续', error));
    const subscription = client.account.messageNotifications.onClick.subscribe(scope, {
      onData: consume,
    });
    consume();
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [scopeKey]);
}
