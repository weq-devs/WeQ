import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getQueryKey } from '@trpc/react-query';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useHostDataSaver } from '../lib/dataSaver';

export interface VoiceTranscriptionInput {
  t: number;
  name: string;
  token: string;
  msgId: string;
  forward?: { carrierId: string; kind: 'c2c' | 'group'; conv: string; resId?: string };
}
type VoiceTranscriptionResult = Awaited<
  ReturnType<typeof client.account.transcribeVoice.mutate>
> & {
  automatic: boolean;
};
type VoiceTranscriptionState = { result?: VoiceTranscriptionResult; collapsed?: boolean };

// 识别会启动独立模型进程；聊天内的多个入口共用队列，避免同时加载多份模型。
let transcriptionTail: Promise<unknown> = Promise.resolve();
export function queueVoiceTranscription<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const task = transcriptionTail.then(() => {
    signal.throwIfAborted();
    return run();
  });
  transcriptionTail = task.catch(() => undefined);
  return task;
}

/** 气泡、右键菜单与自动识别共用缓存，空识别结果和失败也保留，只有手动操作才重试。 */
export function useVoiceTranscription(input: VoiceTranscriptionInput, automatic = false) {
  const queryClient = useQueryClient();
  const restricted = useHostDataSaver();
  const manual = useRef(false);
  const resumed = useRef<string | undefined>(undefined);
  const accountUin = useViewState((state) => state.openedUin);
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: Boolean(accountUin),
  });
  const binding =
    accountUin && config.data?.uin === accountUin && config.data.configId
      ? { expectedAccountUin: accountUin, expectedAccountConfigId: config.data.configId }
      : null;
  const modelId = settings.data?.voiceTranscribe.modelId ?? '';
  const available = Boolean(binding && modelId && input.name && Number.isFinite(input.t));
  const shouldResume =
    available && automatic && Boolean(settings.data?.voiceTranscribe.autoTranscribe);
  const queryKey = [...getQueryKey(trpc.account), 'voiceTranscription', binding, modelId, input];
  const query = useQuery<VoiceTranscriptionState>({
    queryKey,
    queryFn: ({ signal }) => {
      const auto = !manual.current;
      manual.current = false;
      return queueVoiceTranscription(signal!, async () => {
        if (!binding || !available) throw new Error('请先在设置中下载本地语音模型');
        let result: VoiceTranscriptionResult;
        try {
          const reply = await client.account.transcribeVoice.mutate({
            ...input,
            ...binding,
            automatic: auto,
          });
          result = { ...reply, automatic: auto };
        } catch (error) {
          result = {
            success: false,
            automatic: auto,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return {
          result,
          collapsed: queryClient.getQueryData<VoiceTranscriptionState>(queryKey)?.collapsed,
        };
      });
    },
    enabled: shouldResume,
    staleTime: Infinity,
    cacheTime: 5 * 60_000,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data, isFetching, refetch } = query;
  const resumeKey = JSON.stringify([binding, modelId, input]);
  useEffect(() => {
    if (restricted) resumed.current = undefined;
    else if (
      shouldResume &&
      data?.result?.deferred &&
      !isFetching &&
      resumed.current !== resumeKey
    ) {
      resumed.current = resumeKey;
      void refetch({ cancelRefetch: false });
    }
  }, [restricted, shouldResume, data, isFetching, refetch, resumeKey]);
  const setCollapsed = (collapsed: boolean) =>
    queryClient.setQueryData<VoiceTranscriptionState>(queryKey, (current) => ({
      ...current,
      collapsed,
    }));
  return {
    available,
    busy: query.isFetching,
    result: query.data?.result?.deferred ? undefined : query.data?.result,
    error: query.error instanceof Error ? query.error.message : null,
    collapsed: query.data?.collapsed ?? false,
    setCollapsed,
    run: () => {
      if (!available || query.isFetching) return;
      if (query.data?.collapsed) setCollapsed(false);
      manual.current = true;
      void query.refetch();
    },
  };
}
