import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import {
  FEATURE_CATALOG_VERSION,
  FEATURE_DOMAINS,
  listFeatures,
  type FeatureDefinition,
  type FeatureDomain,
} from '../packages/service/src/common/feature_catalog';
import { featureUnsupported } from '../apps/desktop/src/shared/feature_access';
import {
  ASSISTANT_BASE_SPECS,
  ANALYZE_ATTACHED_IMAGE_SPEC,
} from '../packages/service/src/account/assistant_local_tools';
import type { APP_NAVIGATION } from '../apps/desktop/src/renderer/src/lib/appNavigation';
import type { AppSearchEntry } from '../apps/desktop/src/renderer/src/components/search/appSearchCatalog';

const ROOT = resolve(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');
const REFERENCE = join(DOCS, 'guide/features.md');
const DOMAIN_LABELS: Record<FeatureDomain, string> = {
  general: '应用',
  messages: '消息',
  contacts: '联系人',
  groups: '群聊',
  collections: '收藏',
  qzone: 'QQ 空间',
  mail: 'QQ 邮箱',
  channels: 'QQ 频道',
  appearance: '个性装扮',
  export: '导出与任务',
  analysis: '分析',
  assistant: '助手与克隆',
  settings: '设置',
  maintenance: '维护与诊断',
};

/** 解析实际传给 MCP 和助手的注册表，不载入工具或自行添加工具名。 */
export function readRegisteredTools(source: string): Set<string> {
  const file = ts.createSourceFile('tools.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations]);
  const entries = declarations.find(
    ({ name }) => ts.isIdentifier(name) && name.text === 'AI_TOOLS',
  )?.initializer;
  if (!entries || !ts.isArrayLiteralExpression(entries)) throw new Error('未找到实际工具注册数组');
  const names = new Set<string>();
  for (const entry of entries.elements) {
    const declaration = ts.isCallExpression(entry) ? entry.arguments[0] : undefined;
    const property =
      declaration && ts.isObjectLiteralExpression(declaration)
        ? declaration.properties.find((item) => item.name?.getText(file) === 'name')
        : undefined;
    if (
      !property ||
      !ts.isPropertyAssignment(property) ||
      !ts.isStringLiteral(property.initializer)
    )
      throw new Error('工具注册项缺少可核对的名称');
    const name = property.initializer.text;
    if (names.has(name)) throw new Error(`工具注册名重复：${name}`);
    names.add(name);
  }
  return names;
}

export function verifyFeatureReferences(
  features: readonly FeatureDefinition[],
  tools: ReadonlySet<string>,
  docs: ReadonlyMap<string, string>,
) {
  const ids = new Set(features.map(({ id }) => id));
  if (ids.size !== features.length) throw new Error('功能目录存在重复 ID');
  const anchors = new Map<string, Set<string>>();
  for (const [file, text] of docs) {
    const found = new Set<string>();
    for (const [, id] of text.matchAll(/^<a id="feature-([a-z0-9.:-]+)"><\/a>[ \t]*$/gm)) {
      if (!id || !ids.has(id)) throw new Error(`${file} 使用了不存在的功能 ID：${id}`);
      if (found.has(id)) throw new Error(`${file} 的功能锚点重复：${id}`);
      found.add(id);
    }
    anchors.set(file, found);
  }
  for (const feature of features) {
    for (const tool of feature.tools ?? [])
      if (!tools.has(tool)) throw new Error(`${feature.id} 引用了未注册的工具：${tool}`);
    for (const reference of feature.docs ?? []) {
      const [file, anchor, extra] = reference.split('#');
      if (!file || !docs.has(file)) throw new Error(`${feature.id} 引用了不存在的文档：${file}`);
      if (
        anchor !== undefined &&
        (extra !== undefined ||
          anchor !== `feature-${feature.id}` ||
          !anchors.get(file)?.has(feature.id))
      )
        throw new Error(`${feature.id} 的文档锚点失效：${reference}`);
    }
  }
}

export function verifyGeneratedReference(actual: string | undefined, expected: string): void {
  if (actual !== expected) throw new Error('功能参考页缺失或不同步，请运行 pnpm features:docs');
}

function readDocs() {
  const pages = new Map<string, string>();
  for (const section of ['guide', 'develop', 'database', 'tools']) {
    for (const entry of readdirSync(join(DOCS, section), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const path = join(entry.parentPath, entry.name);
        pages.set(relative(DOCS, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'));
      }
    }
  }
  return pages;
}

interface NavigationSnapshot {
  search: readonly AppSearchEntry[];
  navigation: typeof APP_NAVIGATION;
}
async function navigationSnapshot(client: 'desktop' | 'web'): Promise<NavigationSnapshot> {
  // 读取真实的渲染层入口，复用其 Web 投影。此处只加载静态导航数据。
  const result = await build({
    absWorkingDir: ROOT,
    stdin: {
      contents:
        "export { APP_NAVIGATION as navigation } from './apps/desktop/src/renderer/src/lib/appNavigation.ts';\n" +
        "export { APP_SEARCH_ENTRIES as search } from './apps/desktop/src/renderer/src/components/search/appSearchCatalog.ts';",
      resolveDir: ROOT,
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    define: {
      'import.meta.env.VITE_WEQ_TARGET': JSON.stringify(client),
      'process.env.NODE_ENV': '"production"',
    },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.contents).toString('base64')}`
  );
}

const cell = (text: string) =>
  text.replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', ' ');
const contextLabels = {
  account: '账号与数据源',
  group: '群',
  contact: '联系人',
  conversation: '会话',
  content: '内容项',
  message: '消息',
};
const placementLabels = {
  rail: '主导航',
  'mobile-tabs': '手机标签栏',
  'mobile-more': '手机更多',
  workspace: '工作区',
};

function describeNavigation(
  feature: FeatureDefinition,
  desktop: NavigationSnapshot,
  web: NavigationSnapshot,
) {
  const search = desktop.search.find((entry) => entry.id === feature.id);
  const webSearch = web.search.some(({ id }) => id === feature.id);
  const navigation = Object.values(desktop.navigation).find(
    ({ featureId }) => featureId === feature.id,
  );
  const webNavigation = Object.values(web.navigation).find(
    ({ featureId }) => featureId === feature.id,
  );
  const placements = Object.entries(placementLabels)
    .filter(([key]) => navigation && Object.hasOwn(navigation.placements, key))
    .map(([, label]) => label);
  const webPlacement = Object.keys(placementLabels).some(
    (key) => webNavigation && Object.hasOwn(webNavigation.placements, key),
  );
  const clients = [
    search || placements.length ? '桌面' : '',
    webSearch || webPlacement ? 'Web' : '',
    !featureUnsupported(feature, 'remote') && (webSearch || webPlacement) ? 'Remote' : '',
  ].filter(Boolean);
  const place = placements;
  if (search) place.push(search.target.kind === 'setting' ? search.path : '全局搜索');
  if (search?.target.kind === 'dressup' || navigation?.target.kind === 'dressup')
    place.push('需启用开发装扮入口');
  if (feature.context?.length)
    place.push(`需要${feature.context.map((key) => contextLabels[key]).join('、')}`);
  return { clients: clients.join('、') || '—', entry: place.join('；') || '—' };
}

function renderReference(
  features: readonly FeatureDefinition[],
  desktop: NavigationSnapshot,
  web: NavigationSnapshot,
) {
  const lines = [
    '# 功能参考',
    '',
    '<!-- 由 pnpm features:docs 从功能目录和实际导航生成，请勿编辑此页。 -->',
    '',
    `目录格式版本 ${FEATURE_CATALOG_VERSION}。支持端列出已登记的界面入口；实际能否打开或执行还取决于账号、对象和运行条件。工具列是功能关联，可用工具以当前助手或 MCP 的注册结果为准。`,
    '',
    '单项设置见[设置项参考](./settings-reference.md)。设置项的功能 ID 由 `setting:` 加原设置 ID 构成。工具发现见 [MCP 服务器](./mcp-server.md)。',
  ];
  for (const domain of FEATURE_DOMAINS) {
    const relevant = features.filter(
      (feature) => feature.domain === domain && feature.kind !== 'setting',
    );
    if (!relevant.length) continue;
    lines.push(
      '',
      `## ${DOMAIN_LABELS[domain]}`,
      '',
      '| 功能 | 稳定 ID | 支持端 | 入口或条件 | 关联工具 |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const feature of relevant) {
      const { clients, entry } = describeNavigation(feature, desktop, web);
      const links = (feature.docs ?? []).map((reference, index) => {
        const [file, anchor] = reference.split('#');
        const path = relative(dirname(REFERENCE), join(DOCS, file!)).replaceAll('\\', '/');
        return `[${index === 0 ? '说明' : `说明 ${index + 1}`}](${path.startsWith('.') ? path : `./${path}`}${anchor ? `#${anchor}` : ''})`;
      });
      const description = [cell(feature.label), feature.summary && cell(feature.summary), ...links]
        .filter(Boolean)
        .join(' · ');
      const tools = (feature.tools ?? []).map((name) => `\`${name}\``).join('、') || '—';
      lines.push(`| ${description} | \`${feature.id}\` | ${clients} | ${cell(entry)} | ${tools} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const features = listFeatures();
  const tools = readRegisteredTools(
    readFileSync(join(ROOT, 'apps/desktop/src/main/mcp/tools.ts'), 'utf8'),
  );
  for (const spec of [...ASSISTANT_BASE_SPECS, ANALYZE_ATTACHED_IMAGE_SPEC])
    tools.add(spec.function.name);
  verifyFeatureReferences(features, tools, readDocs());
  const [desktop, web] = await Promise.all([
    navigationSnapshot('desktop'),
    navigationSnapshot('web'),
  ]);
  const expected = renderReference(features, desktop, web);
  if (process.argv.includes('--check')) {
    let actual: string | undefined;
    try {
      actual = readFileSync(REFERENCE, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    verifyGeneratedReference(actual, expected);
    console.log('功能参考页与目录、导航、工具及文档关联一致');
  } else {
    writeFileSync(REFERENCE, expected);
    console.log('已生成功能参考页');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
