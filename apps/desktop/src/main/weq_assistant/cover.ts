import { createImageProcessor } from '../image_processor';
import { getWeqTheme, type WeqTheme } from './theme';
export { loadCjkFont } from './cover_font';

export interface CardSpec {
  title: string;
  subtitle?: string;
  footer?: string;
  tag?: string;
  theme?: WeqTheme;
  width?: number;
  height?: number;
}

export interface CardRenderRequest {
  operation: 'cover';
  spec: CardSpec;
}

// 独立于缩略图队列，避免封面排版占用主进程或阻塞聊天图片解码。
const processor = createImageProcessor<CardRenderRequest>({
  workerName: 'coverWorker.mjs',
  timeoutMs: 90_000,
});

export async function renderCardPng(spec: CardSpec): Promise<Buffer> {
  return (await processor.run({
    operation: 'cover',
    spec: { ...spec, theme: spec.theme ?? getWeqTheme() },
  })) as Buffer;
}

export function dailyCardSpec(dateLabel: string): CardSpec {
  return {
    title: '欢迎使用 WeQ！',
    subtitle: 'NTQQ 本地消息数据库解密 · 解析 · 导出工具',
    footer: dateLabel,
    tag: '欢迎使用',
  };
}
