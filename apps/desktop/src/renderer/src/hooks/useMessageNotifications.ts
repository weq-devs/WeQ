import { useEffect, useMemo, useRef } from 'react';
import { NEW_CONV_FRESH_SEC } from '@weq/service/live-message';
import { plainContentText, type PlainElement } from '@weq/service/message-plain-text';
import { client } from '../trpc/client';
import { accountBinding, preferenceValue, useClientPreferences } from '../lib/clientPreferences';
import { useAppLock } from '../state/lock';
import { IS_WEB } from '../lib/target';
import { defaultConversationPreference } from '../im-template/template/preferences';
import type { Conversation, ConversationPreferences } from '../im-template/template/types';
import type { ChatMsgWire } from '../../../main/ipc/serde';
import type { NewMessagesWire } from '../../../main/ipc/routers/account';
import type { WebNotice } from '../../../main/web/notices';
import { ordinaryNoticeEligible } from '../../../shared/message_notifications';
import { WEB_NOTICE_OPEN, browserNoticeChannel } from '../lib/browserNotifications';

export function useMessageNotifications(options: {
  selfUin: string;
  selfUid?: string;
  conversations: Conversation[];
  preferences: ConversationPreferences;
  badgeCount: number;
  foregroundConversation?: string;
  groupAssistantIds?: ReadonlySet<string>;
}) {
  useClientPreferences((state) => state.tick);
  const locked = useAppLock((state) => state.locked);
  const enabled = preferenceValue('messageNotifications');
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
      { message: ChatMsgWire; title: string; body: string; count: number }
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
      notices.set(convKey, {
        message,
        title: policy.name || message.conv,
        body: plainContentText(elements).slice(0, 1700) || '[消息]',
        count: (notices.get(convKey)?.count ?? 0) + 1,
      });
    }
    while (seen.current.size > 5000) seen.current.delete(seen.current.values().next().value!);
    while (pending.current.size > 500) pending.current.delete(pending.current.keys().next().value!);
    for (const item of notices.values()) {
      const title = latest.current.privacy ? 'WeQ' : item.title.slice(0, 512);
      const body = latest.current.privacy
        ? '收到新消息'
        : item.body + (item.count > 1 ? `\n另有 ${item.count - 1} 条消息` : '');
      const notice: WebNotice = {
        uin: scope.expectedAccountUin,
        configId: scope.expectedAccountConfigId,
        kind: 'message',
        title,
        body,
        target: { kind: item.message.kind, conv: item.message.conv, seq: item.message.msgSeq },
      };
      if (IS_WEB) {
        channel.current?.show(notice);
      } else
        void client.account.messageNotifications.notify
          .mutate({
            ...scope,
            messageId: item.message.msgId,
            kind: item.message.kind,
            conv: item.message.conv,
            seq: item.message.msgSeq,
            title,
            body,
            private: latest.current.privacy,
          })
          .catch((error: unknown) => console.warn('[message-notifications] 通知未提交', error));
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
