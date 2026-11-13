import { stripVTControlCharacters } from 'node:util';
import type { Logger, Plugin, ResolvedConfig, Rolldown } from 'vite';

const LANGUAGE_MODULE = /\/node_modules\/@shikijs\/langs\//;
const GRAMMAR_MODULE = /\/node_modules\/@shikijs\/langs\/dist\/(cpp|cpp-macro|emacs-lisp)\.mjs$/;

// 仅这两份已知按需语法使用独立预算；业务脚本仍遵循 Vite 的默认阈值。
const GRAMMAR_BUDGETS = { cpp: 700_000, 'emacs-lisp': 900_000 };
const RAW_WARNINGS = Symbol.for('weq.web.chunk-budget.raw-warnings');
type BudgetLogger = Logger & { [RAW_WARNINGS]?: Pick<Logger, 'warn' | 'warnOnce'> };

function nativeSizeWarning(text: string): boolean {
  const clean = stripVTControlCharacters(text).trim();
  return (
    /^(?:\[plugin (?:builtin:vite-reporter|vite:reporter|native:reporter)\]\s*)?\(!\) Some chunks are larger than [\d.]+ kB after minification\./.test(
      clean,
    ) || /^部分构建块压缩后超过 [\d.]+ kB$/.test(clean)
  );
}

export function webChunkBudget() {
  let config: ResolvedConfig;
  let measured = false;
  let closed = false;
  let pending: (() => void)[] = [];
  const plugin: Plugin = {
    name: 'weq-web-chunk-budget',
    apply: 'build',
    configResolved(value) {
      config = value;
      const logger = config.logger as BudgetLogger;
      let raw = logger[RAW_WARNINGS];
      if (!raw) {
        raw = { warn: logger.warn.bind(logger), warnOnce: logger.warnOnce.bind(logger) };
        // 复用 logger 时替换当前处理器，不把上次构建的过滤器串起来。
        Object.defineProperty(logger, RAW_WARNINGS, { value: raw });
      }
      const intercept =
        (forward: Logger['warn']): Logger['warn'] =>
        (text, options) => {
          if (nativeSizeWarning(text)) {
            if (measured) return;
            if (!closed) {
              pending.push(() => forward(text, options));
              return;
            }
          }
          forward(text, options);
        };
      // 原生 reporter 也可能直接调用 logger，不能只拦截 Rolldown 的 onLog。
      logger.warn = intercept(raw.warn);
      logger.warnOnce = intercept(raw.warnOnce);
    },
    buildStart() {
      measured = false;
      closed = false;
      pending = [];
    },
    writeBundle: {
      order: 'pre',
      handler(_options, bundle) {
        if (!config.build.minify || config.build.lib || config.build.ssr) return;
        const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
        const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
        const eager = new Set<string>();
        const visit = (chunk: Rolldown.OutputChunk) => {
          if (eager.has(chunk.fileName)) return;
          eager.add(chunk.fileName);
          for (const name of chunk.imports) {
            const imported = byName.get(name);
            if (imported) visit(imported);
          }
        };
        for (const chunk of chunks) {
          if (
            chunk.isEntry ||
            Object.keys(chunk.modules).some((id) => !LANGUAGE_MODULE.test(id.replaceAll('\\', '/')))
          )
            visit(chunk);
        }
        const defaultBudget = config.build.chunkSizeWarningLimit * 1000;
        for (const chunk of chunks) {
          const bytes = Buffer.byteLength(chunk.code);
          if (bytes <= defaultBudget) continue;
          const ids = Object.keys(chunk.modules);
          const grammars = ids.map((id) => GRAMMAR_MODULE.exec(id.replaceAll('\\', '/'))?.[1]);
          const family =
            grammars.length && grammars.every((name) => name === 'cpp' || name === 'cpp-macro')
              ? 'cpp'
              : grammars.length && grammars.every((name) => name === 'emacs-lisp')
                ? 'emacs-lisp'
                : null;
          const grammarBudget =
            family && !eager.has(chunk.fileName) ? GRAMMAR_BUDGETS[family] : null;
          if (grammarBudget && bytes <= grammarBudget) continue;
          this.warn(
            `构建块超出体积预算：${chunk.fileName} ${(bytes / 1000).toFixed(1)} kB > ${(grammarBudget ?? defaultBudget) / 1000} kB`,
          );
        }
        measured = true;
      },
    },
    closeBundle: {
      order: 'post',
      handler() {
        closed = true;
        if (!measured) for (const warn of pending) warn();
        pending = [];
      },
    },
  };
  return { plugin };
}
