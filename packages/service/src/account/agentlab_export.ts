/**
 * 把一个训练好的克隆体 persona 导出成自包含的 OneBot bot 产物文件夹。
 *
 * 产物结构（见 plan / README）：
 *   <outDir>/
 *   ├── bot.mjs          # esbuild 预打包的 @weq/bot + @weq/agentlab 引擎（resources/bot-runtime/bot.mjs）
 *   ├── index.mjs        # 入口：读 config.json + startBot
 *   ├── config.json      # adapter/selfId/providers/features
 *   ├── package.json     # deps: ws
 *   ├── README.md
 *   └── persona/         # AgentLabStore 目录：<id>.json + stickers/ + voice/
 *
 * 纯文件操作，不碰 provider 解析/网络——上层（procedure）把 LLM/TTS provider 配置、bot.mjs 路径都备好传进来。
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { AgentLabPersona, AgentLabStoredPair, TtsProviderConfig } from '@weq/agentlab';

export interface BotExportLlmProvider {
  id: string;
  baseUrl: string;
  apiKey: string;
}

export interface BotExportInput {
  /** 产物根目录（应为空目录或新建）。 */
  outDir: string;
  /** 预打包引擎 bot.mjs 的绝对路径（resources/bot-runtime/bot.mjs）。 */
  botRuntimeMjs: string;
  persona: AgentLabPersona;
  pairs: AgentLabStoredPair[];
  /** 源资产根目录（该账号的 agentlab 目录，stickers/ 和 voice/ 在这）。 */
  agentlabRoot: string;
  /** persona.models 用到的 LLM provider（已抽好 baseUrl/apiKey）。 */
  llmProviders: BotExportLlmProvider[];
  /** persona.voice 用到的 TTS provider（整份配置，含 key）。 */
  ttsProviders: TtsProviderConfig[];
  adapter: { type: 'napcat' | 'snowluma'; wsUrl: string; token?: string };
  /** bot 自己的 QQ 号。 */
  selfId: string;
  features: { voice: boolean; groupChat: boolean; groupReplyMode?: 'llm' | 'heuristic' };
  /** 本机 WebUI 控制台端口（默认 8090）。 */
  webuiPort?: number;
  /**
   * 图像（vision）模型：写进导出 persona 的 models.vision，供 bot 运行时解析「上传的新表情」。
   * 缺省时沿用 persona 原有的 models.vision（克隆时若选过 vision 就有）。其 provider 必须在 llmProviders 里。
   */
  visionModel?: { providerId: string; model: string };
}

export interface BotExportResult {
  outDir: string;
  stickerCount: number;
  voiceClipCount: number;
  /** 生成的 WebUI 访问信息（密钥请提示用户妥善保管）。 */
  webui: { port: number; key: string; id: string; url: string };
}

async function copyIfExists(src: string, dest: string): Promise<boolean> {
  if (!src || !existsSync(src)) return false;
  await copyFile(src, dest);
  return true;
}

export async function buildBotExport(input: BotExportInput): Promise<BotExportResult> {
  const personaDir = join(input.outDir, 'persona');
  const stickersDir = join(personaDir, 'stickers');
  const voiceDir = join(personaDir, 'voice');
  await mkdir(stickersDir, { recursive: true });
  await mkdir(voiceDir, { recursive: true });

  // 1) 引擎 bot.mjs。
  await copyFile(input.botRuntimeMjs, join(input.outDir, 'bot.mjs'));

  // 2) persona（深拷贝后重定位资产路径：绝对 → 产物内相对）。
  const persona: AgentLabPersona = JSON.parse(JSON.stringify(input.persona));

  // 图像模型：显式指定则写进 persona.models.vision（单一事实源——bot 解析新表情、runtime 都读它）。
  if (input.visionModel) {
    persona.models = { ...persona.models, vision: input.visionModel };
  }

  // 表情图：复制到 persona/stickers/<md5>.png（bot 出站按 md5 就地找，不依赖 localPath）。
  let stickerCount = 0;
  for (const st of persona.stickers ?? []) {
    const src = st.localPath || join(input.agentlabRoot, 'stickers', `${st.md5}.png`);
    if (await copyIfExists(src, join(stickersDir, `${st.md5}.png`))) {
      st.localPath = join('stickers', `${st.md5}.png`); // 相对 personaDir（bot 启动时 resolve）
      stickerCount += 1;
    }
  }

  // 语音参考音频：复制到 persona/voice/<file>，refClips[].path 改成相对（bot 启动时 join personaDir）。
  let voiceClipCount = 0;
  for (const clip of persona.voiceProfile?.refClips ?? []) {
    const file = basename(clip.path);
    if (await copyIfExists(clip.path, join(voiceDir, file))) {
      clip.path = join('voice', file);
      voiceClipCount += 1;
    }
  }

  // 3) persona 记录（AgentLabStore 格式：<id>.json = { persona, pairs }）。
  await writeFile(
    join(personaDir, `${persona.id}.json`),
    JSON.stringify({ persona, pairs: input.pairs }, null, 2),
    'utf-8',
  );

  // 4) config.json（含随机生成的 WebUI 访问密钥 + bot 编号）。
  const webuiPort = input.webuiPort && input.webuiPort > 0 ? input.webuiPort : 8090;
  const webui = {
    enabled: true,
    port: webuiPort,
    key: randomBytes(16).toString('hex'), // 32 位 hex 密钥
    id: randomUUID(),
  };
  const config = {
    adapter: { type: input.adapter.type, wsUrl: input.adapter.wsUrl, token: input.adapter.token ?? '' },
    selfId: input.selfId,
    personaDir: './persona',
    llmProviders: input.llmProviders,
    ttsProviders: input.ttsProviders,
    features: input.features,
    webui,
  };
  await writeFile(join(input.outDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  // 5) index.mjs 入口。
  await writeFile(join(input.outDir, 'index.mjs'), INDEX_MJS, 'utf-8');

  // 6) package.json。
  const pkg = {
    name: `${sanitizeName(persona.name)}-bot`,
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'node index.mjs' },
    dependencies: { ws: '^8.18.0' },
  };
  await writeFile(join(input.outDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');

  // 7) README。
  const webuiUrl = `http://127.0.0.1:${webuiPort}`;
  await writeFile(join(input.outDir, 'README.md'), renderReadme(persona.name, input, { ...webui, url: webuiUrl }), 'utf-8');

  return {
    outDir: input.outDir,
    stickerCount,
    voiceClipCount,
    webui: { port: webuiPort, key: webui.key, id: webui.id, url: webuiUrl },
  };
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'clone';
}

const INDEX_MJS = `// 克隆体 bot 入口：读 config.json，把相对资产路径补成绝对，启动 bot。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startBot } from './bot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// 每次（含重载）都重读 config.json，改配置后从 WebUI「重载配置」即可生效，无需手动重启。
function loadConfig() {
  const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf-8'));
  config.personaDir = join(here, config.personaDir);
  return config;
}

startBot(loadConfig(), { reloadConfig: loadConfig }).then(
  () => console.log('克隆体 bot 已启动。Ctrl+C 退出。'),
  (err) => { console.error('启动失败:', err); process.exit(1); },
);
`;

function renderReadme(
  name: string,
  input: BotExportInput,
  webui: { port: number; key: string; id: string; url: string },
): string {
  return `# ${name} · 克隆体 Bot

由 WeQ 导出。这是一个自包含的 OneBot bot，连接 **${input.adapter.type}** 后即可让克隆体作为 QQ bot 上线。

## 启动

\`\`\`bash
npm install    # 安装 ws（唯一运行时依赖）
npm start
\`\`\`

启动后 bot 会自动开启本机 **WebUI 控制台**，可查看 token 消耗、收发消息统计与克隆体总览。

## WebUI 控制台

- 地址：${webui.url}
- 访问密钥（首次打开需输入）：\`${webui.key}\`
- bot 编号：\`${webui.id}\`

> 控制台仅监听 \`127.0.0.1\`（本机），用上面的密钥鉴权。改端口 / 关闭：编辑 \`config.json\` 的 \`webui\` 段。

## 配置（config.json）

- \`adapter.wsUrl\`：${input.adapter.type} 的正向 WebSocket 地址（当前：\`${input.adapter.wsUrl}\`）。
- \`adapter.token\`：连接鉴权 token（Authorization: Bearer）。
- \`selfId\`：bot 的 QQ 号（当前：\`${input.selfId}\`）。
- \`features.voice\`：是否允许发语音（当前：${input.features.voice ? '开' : '关'}）。
- \`features.groupChat\`：是否参与群聊（当前：${input.features.groupChat ? '开' : '关'}）。
- \`features.groupReplyMode\`：群聊回复意愿决策（当前：${
    (input.features.groupReplyMode ?? 'llm') === 'llm' ? 'llm·拟人判断' : 'heuristic·启发式打分'
  }）。\`llm\`=克隆体带上下文自己判断要不要开口（更自然，每条群消息多一次 LLM 调用）；\`heuristic\`=纯启发式打分（快·省 token）。
- \`webui.port\`：控制台端口（当前：\`${webui.port}\`）；\`webui.enabled\` 设为 false 可关闭。

## ⚠️ 安全提示

\`config.json\` 里含有你的 **LLM / TTS API Key**（明文）以及 **WebUI 访问密钥**。请妥善保管这个文件夹，不要公开分享。
`;
}
