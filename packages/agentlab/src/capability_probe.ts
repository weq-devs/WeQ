import { randomInt } from 'node:crypto';
import { ApiHttpError, requestApiJson } from './api_usage';
import { embedTexts, pickMessageText } from './http';
import type { AgentLabEndpoint, AgentLabModelCapability } from './types';

export interface CapabilityProbeResult {
  capability: AgentLabModelCapability;
  status: 'supported' | 'unsupported' | 'unknown';
  detail: string;
}

// 内置 32×32 纯色 PNG，仅用于检测，不读取用户图片。
const PROBE_IMAGES = [
  {
    color: 'red',
    png: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANklEQVRIie3WuQkAQAwDwem/aV0VhgsWnAuMnjVOTwJ6kVy0gqaqWG2qwVmTKaoQeAkdfU3XDzLD/C7nwdQVAAAAAElFTkSuQmCC',
  },
  {
    color: 'blue',
    png: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANklEQVRIie3WuQkAQAwDwem/aV0VhgsWnAuMnsWOTwJ6kVy0gqaqWG2qwVmTKaoQeAkdfUzXDzpL/C66vH+aAAAAAElFTkSuQmCC',
  },
];

function explicitlyUnsupported(error: unknown, capability: AgentLabModelCapability): boolean {
  // 网关、鉴权、限流、模型不存在及参数不兼容均不证明能力不受支持。
  if (!(error instanceof ApiHttpError) || ![400, 404, 422, 501].includes(error.status))
    return false;
  const subject =
    capability === 'embedding'
      ? '(?:embeddings?|/embeddings|向量)'
      : capability === 'vision'
        ? '(?:images?|vision|multimodal|图片|图像|视觉)'
        : '(?:chat|/chat/completions|聊天)';
  return new RegExp(
    `(?:model|模型)[^\\n]{0,160}(?:does not support|doesn't support|不支持)\\s*(?:the\\s+)?${subject}|${subject}(?:\\s+inputs?)?\\s+(?:is\\s+|are\\s+)?not supported by (?:this|the) model`,
    'i',
  ).test(error.detail);
}

/** 使用最小合成输入探测；只认有效输出，暂时性错误保持未确定。 */
export async function detectModelCapabilities(
  endpoint: AgentLabEndpoint,
): Promise<CapabilityProbeResult[]> {
  const results: CapabilityProbeResult[] = [];
  for (const capability of ['chat', 'embedding', 'vision'] as const) {
    const probe = {
      ...endpoint,
      kind: capability,
      feature: 'capability-test',
      timeoutMs: endpoint.timeoutMs ?? 30_000,
    };
    try {
      if (capability === 'embedding') {
        const [vector] = await embedTexts(probe, 'WeQ capability test');
        if (
          !vector?.length ||
          !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
        )
          throw new Error('未返回有效数值向量');
      } else {
        // 两种不同颜色均须识别，避免忽略图片、固定回复颜色的模型被判通过。
        const offset = randomInt(PROBE_IMAGES.length);
        for (let index = 0; index < (capability === 'vision' ? PROBE_IMAGES.length : 1); index++) {
          const image = PROBE_IMAGES[(offset + index) % PROBE_IMAGES.length]!;
          const content =
            capability === 'chat'
              ? 'Reply with OK.'
              : [
                  {
                    type: 'text',
                    text: 'Name the solid color in this image. Reply with one English color word only.',
                  },
                  { type: 'image_url', image_url: { url: `data:image/png;base64,${image.png}` } },
                ];
          const data = await requestApiJson<{
            choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
          }>(probe, '/chat/completions', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${endpoint.apiKey}`,
            },
            body: JSON.stringify({
              model: endpoint.model,
              messages: [{ role: 'user', content }],
              max_tokens: 256,
            }),
          });
          const message = data.choices?.[0]?.message;
          if (!pickMessageText(message)) throw new Error('接口返回内容为空');
          if (
            capability === 'vision' &&
            message?.content
              ?.trim()
              .toLowerCase()
              .replace(/[.!。]$/, '') !== image.color
          )
            throw new Error('接口接受图片，但未正确识别测试图片，视觉能力未确定');
        }
      }
      results.push({ capability, status: 'supported', detail: '测试通过' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        capability,
        status: explicitlyUnsupported(error, capability) ? 'unsupported' : 'unknown',
        detail: detail.replaceAll(endpoint.apiKey || '\0', '[已隐藏]').slice(0, 400),
      });
    }
  }
  return results;
}
