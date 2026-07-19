/**
 * 给 streamdown 注入的代码高亮插件（shiki，纯 JS 引擎）。
 *
 * 为什么要自建：streamdown 自身不带高亮引擎——它只暴露一个 `plugins.code` 插件位
 * （类型 CodeHighlighterPlugin），不注入就把代码块渲染成纯文本。所以要有语法高亮，
 * 必须自己建一个 shiki highlighter 并塞给 `<Streamdown plugins={{ code }} />`。
 *
 * 为什么用 JS 引擎（而非 shiki 默认的 oniguruma WASM）：本应用的 CSP 是
 * `script-src 'self'`（见 renderer/index.html），没有 `wasm-unsafe-eval`——WASM 会被
 * 直接拦下，代码块在运行时报错/不上色。shiki 的 createJavaScriptRegexEngine 是纯 JS
 * 正则实现，不碰 WebAssembly，天然绕开这条 CSP，且不必放宽应用的脚本安全边界。
 *
 * 异步接线：shiki 建实例、加载主题/语言都是异步的，而 streamdown 的 `highlight()` 要求
 * 同步返回（返回 null 表示「还没好」，就绪后走 callback 回填）。本模块因此维护一个惰性
 * 单例 + 「已加载语言」集合：主题与语言都就绪就同步出结果，否则触发后台加载、先返回
 * null，加载完成再用 callback 把该代码块补上色。语言按需动态 import，避免把上百种语法
 * 全量打进包里。
 */

import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages } from 'shiki/langs';
import type { BundledLanguage, CodeHighlighterPlugin, HighlightOptions, ThemeInput } from 'streamdown';

/** 与 streamdown 默认一致的双主题：明/暗各一，随 .dark(data-theme) 切换。 */
const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';
const THEMES: [ThemeInput, ThemeInput] = [LIGHT_THEME, DARK_THEME];

/** highlighter 单例：异步构建（promise）+ 建好后的同步句柄（codeToTokens 本身是同步的）。 */
let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighter: HighlighterCore | null = null;
/** 已成功加载语法的语言集（含归一后的名字）。 */
const loadedLangs = new Set<string>();
/** 正在加载中的语言 → 其 Promise，避免同一语言重复触发 import。 */
const loadingLangs = new Map<string, Promise<void>>();

/** shiki 已内置、无需加载语法的伪语言。 */
const PLAINTEXT_LANGS = new Set(['text', 'txt', 'plaintext', 'ansi', '']);

/** 常见别名 → shiki 的规范语言名（覆盖模型最爱输出的那些 fence 标签）。 */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  proto: 'protobuf',
  dockerfile: 'docker',
};

/** 把 fence 上的语言标签归一到 shiki 认识的名字；非法/未知统一回退到 text。 */
function normalizeLang(raw: string): string {
  const lower = (raw || '').trim().toLowerCase();
  if (PLAINTEXT_LANGS.has(lower)) return 'text';
  const aliased = LANG_ALIASES[lower] ?? lower;
  // 只有确实存在于 bundledLanguages 里的才尝试加载，否则当纯文本（避免 import 报错）。
  return aliased in bundledLanguages ? aliased : 'text';
}

/** 惰性拿到 highlighter 单例（纯 JS 引擎 + 预载双主题，不含任何语言语法）。 */
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [
        import('shiki/themes').then((m) => m.bundledThemes[LIGHT_THEME]()),
        import('shiki/themes').then((m) => m.bundledThemes[DARK_THEME]()),
      ],
      langs: [],
      // 纯 JS 正则引擎：不加载 onig.wasm，规避 CSP `script-src 'self'`。
      engine: createJavaScriptRegexEngine(),
    }).then((hl) => {
      highlighter = hl;
      return hl;
    });
  }
  return highlighterPromise;
}

/**
 * 确保某语言的语法已加载。就绪返回 true（可同步高亮）；未就绪触发后台加载、返回 false，
 * 加载完成后调用 onReady（用来让 streamdown 重新高亮该代码块）。
 */
function ensureLang(lang: string, onReady: () => void): boolean {
  if (lang === 'text' || loadedLangs.has(lang)) return true;
  if (!loadingLangs.has(lang)) {
    const p = (async () => {
      try {
        const hl = await getHighlighter();
        const mod = await bundledLanguages[lang as BundledLanguage]();
        await hl.loadLanguage(mod);
        loadedLangs.add(lang);
      } catch {
        // 加载失败（罕见）：标记为已处理，之后按纯文本渲染，别卡在 loading。
        loadedLangs.add(lang);
      } finally {
        loadingLangs.delete(lang);
      }
    })();
    loadingLangs.set(lang, p);
    void p.then(onReady);
  }
  return false;
}

/** 语言/主题未就绪时的占位返回（纯文本、无 token 上色）。 */
const EMPTY_RESULT = { tokens: [] as never[], bg: undefined, fg: undefined, rootStyle: undefined };

/**
 * 核心高亮：主题+语言都就绪则同步返回 shiki 结果，否则返回 null 并在就绪后经 callback 回填。
 * 抽成独立函数（而非插件对象方法）以便未就绪时的 callback 稳定地自引用。
 */
function doHighlight(
  options: HighlightOptions,
  callback?: (result: ReturnType<NonNullable<CodeHighlighterPlugin['highlight']>> & object) => void,
): ReturnType<NonNullable<CodeHighlighterPlugin['highlight']>> {
  // highlighter 实例还没建好：建好后重新触发一次高亮。
  if (!highlighter) {
    void getHighlighter().then(() => callback?.(doHighlight(options) ?? EMPTY_RESULT));
    return null;
  }

  const lang = normalizeLang(options.language);
  // 语言语法未就绪：加载完再回填。
  if (!ensureLang(lang, () => callback?.(doHighlight(options) ?? EMPTY_RESULT))) {
    return null;
  }

  // 主题与语言都就绪：同步 tokenize，返回 shiki 结果（结构即 HighlightResult）。
  const result = highlighter.codeToTokens(options.code, {
    lang: lang === 'text' ? 'text' : (lang as BundledLanguage),
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    defaultColor: false, // 输出 --shiki-light/--shiki-dark 变量，交给 dark: 工具类切换。
  });
  return {
    tokens: result.tokens,
    bg: result.bg,
    fg: result.fg,
    rootStyle: result.rootStyle,
  };
}

/**
 * streamdown 的代码高亮插件（shiki / JS 引擎）。
 * 传给 `<Streamdown plugins={{ code: shikiCodeHighlighter }} />`。
 */
export const shikiCodeHighlighter: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getThemes: () => THEMES,
  getSupportedLanguages: () => Object.keys(bundledLanguages) as BundledLanguage[],
  supportsLanguage: () => true, // 未知语言在 highlight 内部回退到 text，不在此拦。
  highlight: doHighlight,
};
