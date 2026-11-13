import type { OcrResultCache } from '@weq/service';
import { resolveLocalOcrFilterModel, runLocalOcrFilterFile } from './local';

/** 自动 OCR 的预筛选；明确的手动识别入口不调用此函数。 */
export async function prefilterAutomaticOcr(input: {
  enabled: boolean;
  path: string | null;
  cache: OcrResultCache | null;
  cacheKey: string | null;
}): Promise<{ skip: boolean; notes: string[] }> {
  if (!input.enabled) return { skip: false, notes: [] };
  try {
    const model = resolveLocalOcrFilterModel();
    if (!model) return { skip: false, notes: ['筛图模型不可用，继续 OCR。'] };
    const cached =
      input.cache && input.cacheKey
        ? await input.cache.getFilter(input.cacheKey, model.modelId).catch(() => null)
        : null;
    if (cached) return { skip: !cached.hasText, notes: ['复用本机筛图结论。'] };
    if (!input.path) return { skip: false, notes: ['未取得可供筛图的本机图片，继续 OCR。'] };
    const result = await runLocalOcrFilterFile(input.path);
    if (!result.ok || typeof result.hasText !== 'boolean')
      return { skip: false, notes: [`筛图失败，继续 OCR：${result.error ?? '未返回筛图结论'}`] };
    // 执行期间资源可能变更，只缓存实际运行模型的结论。
    if (input.cache && input.cacheKey && result.modelId)
      await input.cache
        .putFilter(input.cacheKey, result.modelId, {
          hasText: result.hasText,
          boxes: result.boxes,
          elapsedMs: result.elapsedMs,
        })
        .catch(() => undefined);
    return {
      skip: !result.hasText,
      notes: [result.hasText ? '筛图检测到文字，继续 OCR。' : '筛图未检测到文字，已跳过 OCR。'],
    };
  } catch (error) {
    return {
      skip: false,
      notes: [`筛图失败，继续 OCR：${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
