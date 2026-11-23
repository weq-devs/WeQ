import { useEffect, useMemo, useRef } from 'react';
import { NEW_CONV_FRESH_SEC } from '@weq/service/live-message';
import type { PlainElement } from '@weq/service/message-plain-text';
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
import {
  incomingNoticeEligible,
  incomingImportantEvents,
  incomingMessageCopy,
  incomingNoticePriority,
} from '../../../shared/message_notifications';
import { PRIVATE_MESSAGE_NOTICE } from '../../../shared/notification_copy';
import { WEB_NOTICE_OPEN, browserNoticeChannel } from '../lib/browserNotifications';
import { useNotificationPolicy, claimMessageBanner } from '../lib/notificationPolicy';
import {
  normalizeNotificationScope,
  normalizeNotificationEvents,
  notificationScopeIncludes,
  type NotificationChannel,
  type NotificationEvent,
} from '@weq/service/notification-settings';
import { useToast } from '../components/Toast.shared';
import { useWebNotices } from '../state/webNotices';

type IncomingMessage = NewMessagesWire['messages'][number];

function currentNoticeEvents() {
  const state = useNotificationPolicy.getState();
  return state.ready
    ? state.events
    : normalizeNotificationEvents(undefined, {
        messageNotifications: preferenceValue('messageNotifications'),
      });
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
          const groupAssistant =
            conversation.type === 'group' &&
            Boolean(options.groupAssistantIds?.has(conversation.id));
          const key = `${conversation.type === 'group' ? 'group' : 'c2c'}:${conversation.id}`;
          return [
            [
              key,
              {
                key,
                muted: Boolean(preference.muted || groupAssistant),
                groupAssistant,
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
  const pending = useRef(new Map<string, { message: IncomingMessage; observedAt: number }>());
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
    for (const message of batch?.messages ?? []) {
      const key = JSON.stringify([
        message.kind,
        message.conv,
        message.noticeIdentity ?? message.msgId,
      ]);
      const previous = pending.current.get(key);
      if (message.live && previous && !previous.message.live) continue;
      pending.current.set(key, {
        message,
        observedAt: (batch?.observedAt ?? Date.now()) / 1000,
      });
    }
    const scopes = sharedAccountRecords('notifications');
    const activeEvents = currentNoticeEvents();
    const notices = new Map<
      string,
      {
        name: string;
        items: {
          message: IncomingMessage;
          elements: PlainElement[];
          reasons: NotificationEvent[];
          keywordNotifies: boolean;
        }[];
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
      if (message.live) {
        const scopeIncludes = (event: 'specialCare' | 'keyword') =>
          notificationScopeIncludes(normalizeNotificationScope(scopes[event], event), policy);
        const enabled = (event: 'specialCare' | 'keyword' | 'groupMessage' | 'directMessage') =>
          activeEvents[event].banner || activeEvents[event].system;
        const carePending =
          enabled('specialCare') &&
          scopeIncludes('specialCare') &&
          !policy.highlights?.some(
            (hit) => hit.msgSeq === message.msgSeq && hit.kind === 'specialCare',
          );
        const keywordPending =
          message.kind === 'group' &&
          enabled('keyword') &&
          scopeIncludes('keyword') &&
          (!message.keywordChecked || message.groupKeyword === true);
        const ordinary = message.kind === 'group' ? 'groupMessage' : 'directMessage';
        // 尚不能确认特别关心或群提醒词优先级时，保留落库后的通知机会。
        if (
          !isAccountStateReady() ||
          !useNotificationPolicy.getState().ready ||
          policy.muted ||
          !enabled(ordinary) ||
          carePending ||
          keywordPending
        )
          continue;
      }
      seen.current.add(key);
      const reading =
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        latest.current.foregroundConversation === message.conv;
      if (
        !incomingNoticeEligible(message, {
          selfUin: options.selfUin,
          selfUid: options.selfUid,
          openedAt: openedAt.current,
          observedAt,
          freshSeconds: NEW_CONV_FRESH_SEC,
          reading,
        })
      )
        continue;
      const elements = message.elements.filter((element): element is PlainElement =>
        Boolean(element && typeof element === 'object'),
      );
      if (elements.length > 0 && elements.every((element) => /^grayTip/i.test(element.type ?? '')))
        continue;
      const reasons: NotificationEvent[] = [];
      if (!policy.muted) reasons.push(message.kind === 'group' ? 'groupMessage' : 'directMessage');
      const important = incomingImportantEvents(elements, options.selfUin, options.selfUid);
      const mapping = {
        atMe: 'mentionMe',
        atAll: 'mentionAll',
        replyMe: 'replyMe',
        redPacket: 'redPacket',
        specialCare: 'specialCare',
      } as const;
      for (const highlight of policy.highlights ?? []) {
        if (highlight.msgSeq !== message.msgSeq) continue;
        if (highlight.kind in mapping)
          important.add(mapping[highlight.kind as keyof typeof mapping]);
      }
      for (const event of important) {
        if (event === 'replyMe' && message.kind !== 'group') continue;
        if (event !== 'specialCare' && !isAccountStateReady()) continue;
        if (notificationScopeIncludes(normalizeNotificationScope(scopes[event], event), policy))
          reasons.push(event);
      }
      if (!reasons.length) continue;
      let notice = notices.get(policy.key);
      if (!notice) {
        notice = { name: policy.name, items: [] };
        notices.set(policy.key, notice);
      }
      const keywordNotifies =
        message.groupKeyword === true &&
        notificationScopeIncludes(normalizeNotificationScope(scopes.keyword, 'keyword'), policy);
      notice.items.push({ message, elements, reasons, keywordNotifies });
    }
    while (seen.current.size > 5000) seen.current.delete(seen.current.values().next().value!);
    while (pending.current.size > 500) pending.current.delete(pending.current.keys().next().value!);
    for (const { name, items } of notices.values()) {
      const currentGeneration = generation.current;
      items.sort((a, b) => {
        const difference = BigInt(a.message.msgSeq) - BigInt(b.message.msgSeq);
        return difference < 0n ? -1 : difference > 0n ? 1 : 0;
      });
      const names = new Map<string, Promise<string>>();
      const showOn = (destination: NotificationChannel) => {
        const events = currentNoticeEvents();
        // 自定义提醒词由专用通知处理，普通消息不能先占用相同的去重键。
        const keywordOwnsChannel =
          events.keyword[destination] &&
          (destination === 'banner' || !IS_WEB || useWebNotices.getState().enabled);
        const eligible = items.filter(
          ({ keywordNotifies, reasons }) =>
            !(keywordNotifies && keywordOwnsChannel) &&
            reasons.some((event) => events[event][destination]),
        );
        const event = incomingNoticePriority.find(
          (event) =>
            events[event][destination] && eligible.some((item) => item.reasons.includes(event)),
        );
        if (!event) return;
        const matching = eligible.filter((item) => item.reasons.includes(event));
        const { message, elements } = matching.at(-1)!;
        const anchor = matching[0]!.message;
        const show = (resolvedName = '') => {
          if (
            generation.current !== currentGeneration ||
            JSON.stringify(accountBinding()) !== scopeKey ||
            !latest.current.enabled ||
            !currentNoticeEvents()[event][destination] ||
            (document.visibilityState === 'visible' &&
              document.hasFocus() &&
              latest.current.foregroundConversation === message.conv)
          )
            return;
          const sender =
            message.kind === 'group'
              ? resolvedName.trim() ||
                (/^[1-9]\d*$/.test(message.senderUin) ? message.senderUin : '群成员')
              : '';
          const { title, body, detail } = latest.current.privacy
            ? { ...PRIVATE_MESSAGE_NOTICE, detail: undefined }
            : incomingMessageCopy({
                name: name.trim() || (message.kind === 'group' ? `群聊 ${message.conv}` : '私聊'),
                sender,
                elements,
                event,
                count: matching.length,
                selfUid: options.selfUid,
              });
          const target = {
            kind: message.kind,
            conv: message.conv,
            seq: anchor.msgSeq,
            msgId: anchor.live ? undefined : anchor.msgId,
          };
          const notice: WebNotice = {
            uin: scope.expectedAccountUin,
            configId: scope.expectedAccountConfigId,
            kind: 'message',
            title,
            body,
            ...(message.noticeIdentity ? { noticeIdentity: message.noticeIdentity } : {}),
            target,
          };
          if (destination === 'banner') {
            if (
              message.kind === 'group' &&
              !claimMessageBanner(notice.configId, 'group', message.conv, message.msgSeq)
            )
              return;
            useToast.getState().push({
              event,
              title,
              summary: body,
              detail,
              messageReadTarget: {
                binding: scope,
                chatType: message.kind === 'group' ? 2 : 1,
                uid: message.conv,
                seq: eligible.at(-1)!.message.msgSeq,
              },
              action: {
                label: '定位消息',
                icon: 'conversation',
                run: () =>
                  window.dispatchEvent(new CustomEvent(WEB_NOTICE_OPEN, { detail: notice })),
              },
            });
          } else if (IS_WEB) {
            channel.current?.show(notice);
          } else {
            void client.account.messageNotifications.notify
              .mutate({
                ...scope,
                messageId: message.noticeIdentity ?? message.msgId,
                anchorId: target.msgId,
                kind: message.kind,
                conv: message.conv,
                seq: target.seq,
                title,
                body,
                private: latest.current.privacy,
                reasons: [event],
              })
              .catch((error: unknown) => console.warn('[message-notifications] 通知未提交', error));
          }
        };
        const resolve = latest.current.resolveGroupSenderName;
        if (message.kind !== 'group' || latest.current.privacy || !resolve) {
          show();
          return;
        }
        const key = message.senderUid || message.senderUin;
        let senderName = names.get(key);
        if (!senderName) {
          senderName = Promise.resolve()
            .then(() => resolve(message))
            .catch((error: unknown) => {
              console.warn('[message-notifications] 发送者名称未补全', error);
              return '';
            });
          names.set(key, senderName);
        }
        void senderName.then(show);
      };
      showOn('banner');
      showOn('system');
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
