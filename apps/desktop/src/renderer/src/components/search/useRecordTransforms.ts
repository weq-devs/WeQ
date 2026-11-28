import { useMemo, useRef, useState } from 'react';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import type { Conversation, Message } from '../../im-template/template/types';
import { ordinaryQqConversation } from '../../lib/conversationActions';
import { client } from '../../trpc/client';
import { useToast } from '../Toast.shared';
import {
  type IntentAnalysis,
  type IntentSenseContextValue,
  useIntentSenseStatus,
} from '../intentSense/context.shared';

type Translation = { id: string; value: string | null; error?: boolean };
const ignoreAnalysisRequest = () => {};

export function useRecordTransforms({
  binding,
  conversation,
  active,
}: {
  binding?: QQWriteBinding;
  conversation: Conversation | null;
  active: boolean;
}) {
  const account = Boolean(binding && conversation && ordinaryQqConversation(conversation));
  const status = useIntentSenseStatus(active && account).data;
  const kind = conversation?.type === 'group' ? 'group' : 'c2c';
  const conv = conversation?.id ?? '';
  const intentAvailable = Boolean(
    active &&
      account &&
      status?.enabled &&
      status.conversationOverrides?.[`${kind}:${conv}`] !== false,
  );
  const [results, setResults] = useState<ReadonlyMap<string, IntentAnalysis>>(() => new Map());
  const [pendingIntent, setPendingIntent] = useState<string>();
  const runningIntent = useRef(false);
  const [translation, setTranslation] = useState<Translation | null>(null);
  const pushToast = useToast((state) => state.push);
  const intentContext: IntentSenseContextValue | null = useMemo(
    () =>
      intentAvailable
        ? {
            active: true,
            automatic: false,
            persistentDisplay: status?.persistentDisplay,
            hoverDisplay: status?.hoverDisplay,
            loadingAnimation: status?.loadingAnimation,
            manualSingleMessageId: pendingIntent,
            isManualPending: (id) => pendingIntent === id,
            version: results.size,
            getAnalysis: (id) => results.get(id),
            isUnavailable: () => false,
            requestAnalysis: ignoreAnalysisRequest,
            latestMessageId: null,
            latestPeerMsgId: null,
            settled: true,
            kind,
            conv,
          }
        : null,
    [intentAvailable, status, pendingIntent, results, kind, conv],
  );

  async function analyze(message: Message) {
    if (!intentAvailable || !binding || runningIntent.current) return;
    runningIntent.current = true;
    setPendingIntent(message.id);
    try {
      const result = await client.account.intentSense.analyzeMessage.mutate({
        ...binding,
        kind,
        conv,
        msgId: message.id,
        manual: true,
      });
      if (!result) throw new Error('未返回有效分析结果，请检查模型状态后重试');
      setResults((previous) => new Map(previous).set(message.id, result));
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '意图感知失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      runningIntent.current = false;
      setPendingIntent(undefined);
    }
  }

  async function translate(message: Message, text: string) {
    if (!binding) return;
    const pending = { id: message.id, value: null };
    setTranslation(pending);
    try {
      const value = await client.account.qqActions.translateEnglish.mutate({ ...binding, text });
      setTranslation((current) => (current === pending ? { ...pending, value } : current));
    } catch (error) {
      const value = error instanceof Error ? error.message : 'QQ 翻译失败';
      setTranslation((current) =>
        current === pending ? { ...pending, value, error: true } : current,
      );
    }
  }

  return {
    intentAvailable,
    intentContext,
    pendingIntent,
    analyze,
    translation,
    translate,
    collapseTranslation: () => setTranslation(null),
  };
}
