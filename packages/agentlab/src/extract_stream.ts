import { randomUUID } from 'node:crypto';
import type { AgentLabEndpoint, AgentLabModelOutput } from './types';
import {
  apiErrorMessage,
  ApiHttpError,
  fetchApi,
  isApiCancellation,
  withApiDeadline,
} from './api_usage';
import { isUnsupportedTemperature, withoutTemperature } from './temperature_fallback';

interface CompletionChunk {
  choices?: Array<{
    index?: number;
    delta?: { content?: string; reasoning_content?: string };
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
}

/** 提炼与 JSON 请求共用期限、记账和温度回退；不重发已开始输出的请求。 */
export function extractStream(endpoint: AgentLabEndpoint, init: RequestInit): Promise<string> {
  return withApiDeadline(endpoint, init, async (request) => {
    const requestId = randomUUID();
    const emit = (event: Omit<AgentLabModelOutput, 'requestId' | 'feature' | 'model'>) => {
      try {
        endpoint.onOutput?.({
          requestId,
          feature: endpoint.feature ?? '模型输出',
          model: endpoint.model,
          ...event,
        });
      } catch {
        // 日志订阅失败不能改变模型结果。
      }
    };
    emit({ status: 'running' });
    let content = '';
    let reasoning = '';
    let outputSize = 0;
    const append = (channel: 'content' | 'reasoning', text: unknown) => {
      if (typeof text !== 'string' || !text) return;
      outputSize += text.length;
      if (outputSize > 2_000_000) throw new Error('模型输出超过提炼容量上限');
      if (channel === 'content') content += text;
      else reasoning += text;
      emit({ status: 'running', channel, text });
    };
    const attempt = async (input: typeof request, retried = false): Promise<string> => {
      const { response, usage, temperatureOmitted } = await fetchApi(
        endpoint,
        '/chat/completions',
        input,
        true,
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let temperatureRejected = false;
      let complete = false;
      let doneMarker = false;
      const consume = (raw: string, plain = false) => {
        if (raw.trim() === '[DONE]') {
          complete = true;
          doneMarker = true;
          return;
        }
        const chunk = JSON.parse(raw) as CompletionChunk;
        usage.report(chunk);
        temperatureRejected = isUnsupportedTemperature(chunk, 200);
        const error = apiErrorMessage(chunk);
        if (error || temperatureRejected)
          throw new Error(`模型服务错误：${error ?? '模型不支持温度参数'}`);
        const choice = chunk.choices?.find((c) => c.index === undefined || c.index === 0);
        const delta = plain ? choice?.message : choice?.delta;
        append('reasoning', delta?.reasoning_content);
        append('content', delta?.content);
        if (choice?.finish_reason) {
          if (choice.finish_reason !== 'stop')
            throw new Error(`模型输出未正常完成：${choice.finish_reason}`);
          complete = true;
        }
        if (plain && choice?.message) complete = true;
      };
      try {
        input.signal.throwIfAborted();
        if (!response.ok)
          throw new ApiHttpError(
            '/chat/completions',
            response.status,
            (await response.text()).slice(0, 300),
          );
        if (!response.body) throw new Error('模型服务未返回响应正文');
        reader = response.body.getReader();
        const cancel = () => {
          void reader?.cancel(input.signal.reason).catch(() => {});
        };
        input.signal.addEventListener('abort', cancel, { once: true });
        try {
          const decoder = new TextDecoder();
          let buffer = '';
          let data: string[] = [];
          let eventSize = 0;
          const stream = response.headers.get('content-type')?.includes('text/event-stream');
          const line = (value: string) => {
            value = value.replace(/\r$/, '');
            if (!value) {
              if (data.length) consume(data.join('\n'));
              data = [];
              eventSize = 0;
            } else if (value.startsWith('data:')) {
              eventSize += value.length;
              if (eventSize > 2_000_000) throw new Error('模型响应事件超过提炼容量上限');
              data.push(value.slice(5).replace(/^ /, ''));
            }
          };
          for (;;) {
            input.signal.throwIfAborted();
            const { value, done } = await reader.read();
            input.signal.throwIfAborted();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            if (buffer.length > 2_000_000) throw new Error('模型响应超过提炼容量上限');
            if (stream) {
              let end = buffer.indexOf('\n');
              while (end >= 0) {
                line(buffer.slice(0, end));
                buffer = buffer.slice(end + 1);
                if (doneMarker) break;
                end = buffer.indexOf('\n');
              }
            }
            if (done || doneMarker) break;
          }
          if (stream && !doneMarker) {
            if (buffer) line(buffer);
            line('');
          } else if (!stream) consume(buffer, true);
          if (!complete) throw new Error('模型流式响应中断，未收到完成标记');
          usage.finish('success');
          return content.trim() ? content : reasoning;
        } finally {
          input.signal.removeEventListener('abort', cancel);
        }
      } catch (error) {
        usage.finish(isApiCancellation(error, input.signal) ? 'cancelled' : 'failed');
        const fallback =
          !retried &&
          !temperatureOmitted &&
          temperatureRejected &&
          !outputSize &&
          !input.signal.aborted
            ? withoutTemperature('/chat/completions', input)
            : null;
        if (fallback) {
          await reader?.cancel().catch(() => {});
          return attempt({ ...fallback, signal: input.signal }, true);
        }
        throw error;
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        } else await response.body?.cancel().catch(() => {});
      }
    };
    try {
      const result = await attempt(request);
      emit({ status: 'success' });
      return result;
    } catch (error) {
      emit({
        status: isApiCancellation(error, request.signal) ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}
