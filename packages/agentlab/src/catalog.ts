import type { AgentLabProviderCatalogEntry } from './types';

/**
 * 厂商模板。新建 provider 时一键带入 baseUrl + 推荐模型（含 capability）。
 * 硅基流动 SiliconFlow 重点推荐：一个 key 同时覆盖聊天 / 向量 / 视觉，最省心。
 */
export const AGENTLAB_PROVIDER_CATALOG: AgentLabProviderCatalogEntry[] = [
  {
    vendor: 'siliconflow',
    label: '硅基流动 SiliconFlow（推荐）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyHint: 'sk-...（在 siliconflow.cn 控制台获取）',
    recommended: true,
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek-V3（聊天）', capabilities: ['chat'] },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen2.5-72B（聊天）', capabilities: ['chat'] },
      { id: 'Qwen/Qwen3-VL-30B-A3B-Instruct', label: 'Qwen3-VL-30B-A3B（视觉）', capabilities: ['chat', 'vision'] },
      { id: 'BAAI/bge-m3', label: 'bge-m3（中文向量）', capabilities: ['embedding'] },
    ],
  },
  {
    vendor: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyHint: 'sk-...',
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat', capabilities: ['chat'] },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner', capabilities: ['chat'] },
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', capabilities: ['chat'] },
      { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', capabilities: ['chat'] },
    ],
  },
  {
    vendor: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyHint: '...（智谱开放平台）',
    models: [
      { id: 'glm-4-flash', label: 'glm-4-flash', capabilities: ['chat'] },
      { id: 'glm-4v-flash', label: 'glm-4v-flash（视觉）', capabilities: ['chat', 'vision'] },
      { id: 'embedding-3', label: 'embedding-3（向量）', capabilities: ['embedding'] },
    ],
  },
  {
    vendor: 'moonshot',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyHint: 'sk-...',
    models: [
      { id: 'moonshot-v1-8k', label: 'moonshot-v1-8k', capabilities: ['chat'] },
      { id: 'moonshot-v1-8k-vision-preview', label: 'moonshot-v1-8k-vision', capabilities: ['chat', 'vision'] },
    ],
  },
  {
    vendor: 'dashscope',
    label: '阿里云百炼 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyHint: 'sk-...',
    models: [
      { id: 'qwen-plus', label: 'qwen-plus', capabilities: ['chat'] },
      { id: 'qwen-vl-plus', label: 'qwen-vl-plus（视觉）', capabilities: ['chat', 'vision'] },
      { id: 'text-embedding-v3', label: 'text-embedding-v3（向量）', capabilities: ['embedding'] },
    ],
  },
  {
    vendor: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyHint: 'sk-...',
    models: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini（聊天/视觉）', capabilities: ['chat', 'vision'] },
      { id: 'gpt-4o', label: 'gpt-4o（聊天/视觉）', capabilities: ['chat', 'vision'] },
      { id: 'text-embedding-3-small', label: 'text-embedding-3-small（向量）', capabilities: ['embedding'] },
    ],
  },
  {
    vendor: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyHint: '本地通常留 ollama 即可',
    models: [
      { id: 'qwen2.5', label: 'qwen2.5', capabilities: ['chat'] },
      { id: 'bge-m3', label: 'bge-m3', capabilities: ['embedding'] },
    ],
  },
  {
    vendor: 'openai-compatible',
    label: 'OpenAI 兼容（自定义）',
    baseUrl: '',
    apiKeyHint: '任意 OpenAI 兼容服务',
    models: [],
  },
];

export function findCatalogEntry(vendor: string): AgentLabProviderCatalogEntry | undefined {
  return AGENTLAB_PROVIDER_CATALOG.find((item) => item.vendor === vendor);
}
