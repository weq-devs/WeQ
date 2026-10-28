import { useQuery } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';

export interface VoiceTranscriptionInput {
  t: number;
  name: string;
  token: string;
  msgId: string;
}
type VoiceTranscriptionResult = Awaited<ReturnType<typeof client.account.transcribeVoice.mutate>>;

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
  const query = useQuery({
    queryKey: [...getQueryKey(trpc.account), 'voiceTranscription', binding, modelId, input],
    queryFn: ({ signal }) =>
      queueVoiceTranscription(signal!, async (): Promise<VoiceTranscriptionResult> => {
        if (!binding || !available) throw new Error('请先在设置中选择本地语音模型');
        try {
          return await client.account.transcribeVoice.mutate({ ...input, ...binding });
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    enabled: available && automatic && Boolean(settings.data?.voiceTranscribe.autoTranscribe),
    staleTime: Infinity,
    cacheTime: 5 * 60_000,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return {
    available,
    busy: query.isFetching,
    result: query.data,
    error: query.error instanceof Error ? query.error.message : null,
    run: () => {
      if (available && !query.isFetching) void query.refetch();
    },
  };
}
