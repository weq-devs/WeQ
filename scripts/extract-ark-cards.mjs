// @ts-nocheck
/**
 * 一次性提取脚本：从 QQ 官方 ark 资源包抠出「每个 app 的字段→节点绑定 + 语义槽位」。
 *
 * 输入：resources/arks_resource/<app>/<timestamp>/index.js
 *   每个 index.js 用 `_setViewTemplate('<id>', `<XML>`)` 注册布局模板，
 *   用 Lua 的 `ViewModel:OnSetMetadata(value)` 定义 `data["field"] -> self.<node>` 绑定。
 * 输出：apps/desktop/src/renderer/src/components/ark/ark-cards.generated.json
 *   { [app]: { defaultMetaKey, variants: { [metaKey]: { jump, slots, bindings } } } }
 *   - bindings: 机械提取的 { 节点id: metaField }（原始，未归一化）
 *   - slots:    自动归一化的 { 语义槽: metaField }（长尾 app 兜底用；
 *               常见 app 的权威槽位在 arkCards.ts 手写覆盖）
 *
 * 只做静态渲染需要的「排版 + 字段绑定」提取——运行时 Lua 逻辑/网络请求/动效一律忽略。
 *
 * ⚠ 重新生成需要重新下载 ark 包放回 resources/arks_resource/ 后再跑：
 *     node scripts/extract-ark-cards.mjs
 *   （原始 25MB 资源在提取后已从仓库删除，只保留本脚本 + 生成的 JSON。）
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SRC_DIR = join(REPO, 'resources', 'arks_resource');
const OUT = join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'components', 'ark', 'ark-cards.generated.json');

// ---- XML 模板：轻量 tokenizer，只取 id/tag/关键属性与层级 ------------------

/** 把一段 ark XML 模板解析成扁平的节点列表 [{ tag, id, size, font, anchors }]. */
function parseTemplateNodes(xml) {
  const nodes = [];
  // 匹配开标签（自闭合或普通），抓取标签名 + 属性串
  const re = /<([A-Za-z]+)\b([^>]*)>/g;
  let m = re.exec(xml);
  while (m) {
    const tag = m[1];
    if (tag === 'Event' || tag.startsWith('On')) {
      m = re.exec(xml);
      continue;
    }
    const attrs = m[2];
    const id = attr(attrs, 'id');
    if (id) {
      nodes.push({
        tag,
        id,
        size: attr(attrs, 'size'),
        font: attr(attrs, 'font'),
        anchors: attr(attrs, 'anchors'),
      });
    }
    m = re.exec(xml);
  }
  return nodes;
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : '';
}

/** 收集一个 index.js 里所有 _setViewTemplate('id', `...`)，返回 { templateId: nodes[] }. */
function collectTemplates(js) {
  const out = {};
  const re = /_setViewTemplate\(\s*'([^']+)'\s*,\s*`([\s\S]*?)`\s*\)/g;
  let m = re.exec(js);
  while (m) {
    out[m[1]] = parseTemplateNodes(m[2]);
    m = re.exec(js);
  }
  return out;
}

// ---- Lua 绑定：从每个 OnSetMetadata 的 metaKey 块抠 node -> field ----------

/**
 * 定位所有 `local data = value["<metaKey>"]` 块，逐块提取 node->field 绑定。
 * 兼容写法：
 *   self.<node>:SetValue(data["f"] | localVar | self.xUrl | 常量)
 *   utils.setSafeText(self.<node>, ...)
 *   utils.[sS]etImageValue(self.<node>, ...)
 *   中转：local <var> = [utils.fixurl(] data["f"] ;  self.<var>Url = data["f"]
 */
function extractVariants(js) {
  const anchors = [...js.matchAll(/local\s+data\s*=\s*value\["(\w+)"\]/g)];
  const variants = {};
  for (let i = 0; i < anchors.length; i++) {
    const metaKey = anchors[i][1];
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : Math.min(js.length, start + 8000);
    const block = js.slice(start, end);

    // 中转变量 -> field
    const local = {}; // 普通局部变量 + self.xxx 都塞进来（self. 前缀保留）
    for (const mm of block.matchAll(/\blocal\s+(\w+)\s*=\s*(?:utils\.fixurl\(\s*)?data\["(\w+)"\]/g)) {
      local[mm[1]] = mm[2];
    }
    for (const mm of block.matchAll(/\bself\.(\w+)\s*=\s*(?:utils\.fixurl\(\s*)?data\["(\w+)"\]/g)) {
      local[`self.${mm[1]}`] = mm[2];
    }

    const resolve = (arg) => {
      arg = arg.trim();
      let mm = /^data\["(\w+)"\]/.exec(arg);
      if (mm) return mm[1];
      mm = /^self\.(\w+)/.exec(arg);
      if (mm && local[`self.${mm[1]}`]) return local[`self.${mm[1]}`];
      if (local[arg]) return local[arg];
      return null;
    };

    const bindings = {};
    const put = (node, arg) => {
      if (!node || bindings[node]) return;
      const f = resolve(arg);
      if (f) bindings[node] = f;
    };
    for (const mm of block.matchAll(/self\.(\w+):SetValue\(\s*([^,)]+?)\s*\)/g)) put(mm[1], mm[2]);
    for (const mm of block.matchAll(/utils\.set[sS]afeText\(\s*self\.(\w+)\s*,\s*([^,)]+)/g)) put(mm[1], mm[2]);
    for (const mm of block.matchAll(/utils\.[sS]etImageValue\(\s*self\.(\w+)\s*,\s*([^,)]+)/g)) put(mm[1], mm[2]);

    const jump = /data\["(jumpUrl|qqdocurl|url)"\]/.exec(block)?.[1] ?? null;

    if (Object.keys(bindings).length > 0) variants[metaKey] = { jump, bindings };
  }
  return variants;
}

// ---- node id -> 语义槽位 归一化（长尾兜底用） -----------------------------

const NAME_SLOT = {
  title: 'title',
  desc: 'desc',
  digest: 'desc',
  content: 'desc',
  summary: 'summary',
  nickname: 'name',
  name: 'name',
  avatar: 'avatar',
  button: 'button',
  tag: 'source',
  source: 'source',
  bottomtag: 'source',
  tagicon: 'sourceIcon',
  sourcelogo: 'sourceIcon',
  bottomtagicon: 'sourceIcon',
  icon: 'sourceIcon',
};
const IMAGE_RE = /^(preview|background|mainimage|cover|pic|picurl|image|thumb)/i;

/** 用节点尺寸把图片判成 thumb（小方图）或 cover（通栏大图）. */
function imageSlot(node) {
  const [w, h] = (node?.size ?? '').split(',').map((n) => parseFloat(n) || 0);
  if (w >= 180 || h >= 100) return 'cover';
  return 'thumb';
}

/** 归一化一个名字（节点 id 或 meta 字段名）到语义槽位；去掉 View/Text/Label 容器后缀。 */
function nameToSlot(name, node) {
  const key = name.toLowerCase().replace(/(view|text|label)$/, '');
  if (NAME_SLOT[key]) return NAME_SLOT[key];
  if (IMAGE_RE.test(key)) return imageSlot(node);
  return null;
}

/** 先按节点 id 归一化，失败再退回按 meta 字段名归一化（更耐长尾）。 */
function autoSlots(bindings, nodeById) {
  const slots = {};
  for (const [node, field] of Object.entries(bindings)) {
    const slot = nameToSlot(node, nodeById[node]) ?? nameToSlot(field, nodeById[node]);
    if (slot && !slots[slot]) slots[slot] = field;
  }
  return slots;
}

// ---- 主流程 --------------------------------------------------------------

function newestTimestampDir(appDir) {
  const subs = readdirSync(appDir).filter((d) => {
    try {
      return statSync(join(appDir, d)).isDirectory();
    } catch {
      return false;
    }
  });
  subs.sort(); // 时间戳目录名，字典序≈时间序，取最新
  return subs.length ? subs[subs.length - 1] : null;
}

function main() {
  if (!existsSync(SRC_DIR)) {
    console.error(`✗ 找不到资源目录：${SRC_DIR}\n  需要把 ark 包放回 resources/arks_resource/ 再跑。`);
    process.exit(1);
  }
  const apps = readdirSync(SRC_DIR).filter((d) => d.startsWith('com.') || d.includes('.'));
  const result = {};
  let ok = 0;
  let skipped = 0;

  for (const app of apps) {
    const appDir = join(SRC_DIR, app);
    let ts;
    try {
      ts = newestTimestampDir(appDir);
    } catch {
      continue;
    }
    if (!ts) continue;
    const file = join(appDir, ts, 'index.js');
    if (!existsSync(file)) {
      skipped++;
      continue;
    }
    const js = readFileSync(file, 'utf8');
    const templates = collectTemplates(js);
    const variants = extractVariants(js);
    const keys = Object.keys(variants);
    if (keys.length === 0) {
      skipped++;
      continue;
    }

    const outVariants = {};
    for (const [metaKey, v] of Object.entries(variants)) {
      // 用同名模板（或第一个模板）的节点尺寸辅助 thumb/cover 判定
      const tpl = templates[metaKey] ?? templates[Object.keys(templates)[0]] ?? [];
      const nodeById = Object.fromEntries(tpl.map((n) => [n.id, n]));
      outVariants[metaKey] = {
        jump: v.jump,
        slots: autoSlots(v.bindings, nodeById),
        bindings: v.bindings,
      };
    }
    result[app] = { defaultMetaKey: keys[0], variants: outVariants };
    ok++;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const kb = (JSON.stringify(result).length / 1024).toFixed(1);
  console.log(`✓ 提取完成：${ok} 个 app 有绑定，${skipped} 个跳过（无绑定/无 index.js）`);
  console.log(`✓ 写入 ${OUT}（${kb} KB）`);

  // ---- 自检：核对几个关键 app 的绑定是否符合预期 ----
  const expect = [
    ['com.tencent.miniapp.lua', 'miniapp', { title: 'title', tag: 'source', bottomTag: 'tag', preview: 'preview' }],
    ['com.tencent.contact.lua', 'contact', { tag: 'tag', avatar: 'avatar' }],
    ['com.tencent.tuwen.lua', 'news', { title: 'title', desc: 'desc', background: 'preview' }],
    ['com.tencent.together', 'invite', { title: 'title', summary: 'summary', button: 'button', mainImage: 'cover' }],
  ];
  console.log('\n自检：');
  for (const [app, metaKey, want] of expect) {
    const got = result[app]?.variants?.[metaKey]?.bindings ?? {};
    const miss = Object.entries(want).filter(([n, f]) => got[n] !== f);
    if (miss.length === 0) {
      console.log(`  ✓ ${app} [${metaKey}] 绑定正确`);
    } else {
      console.log(`  ✗ ${app} [${metaKey}] 不符：期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`);
    }
  }
}

main();
