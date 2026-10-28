import {
  RESOURCE_DIAGNOSTIC_ID,
  RESOURCE_DIAGNOSTIC_REQUEST,
} from '../../../shared/renderer_diagnostics';
import { decorationImageCache } from './decodedImageCache';
import { fontFaces } from './fontFaces';
import type { QueryClient } from '@tanstack/react-query';

let diagnosticQueries: QueryClient | null = null;

export function registerDiagnosticQueries(client: QueryClient): () => void {
  diagnosticQueries = client;
  return () => {
    if (diagnosticQueries === client) diagnosticQueries = null;
  };
}

/** 仅统计缓存与观察者，不遍历查询数据，也不读取 key。 */
export function collectQueryDiagnostics(client: QueryClient | null) {
  if (!client) return {};
  const queries = client.getQueryCache().getAll();
  let activeQueries = 0,
    fetchingQueries = 0,
    queryObservers = 0;
  const sampledQueries = Math.min(queries.length, 512);
  for (let i = 0; i < sampledQueries; i++) {
    const query = queries[i]!;
    if (query.isActive()) activeQueries++;
    if (query.state.fetchStatus === 'fetching') fetchingQueries++;
    queryObservers += query.getObserversCount();
  }
  return {
    queries: queries.length,
    sampledQueries,
    omittedQueries: queries.length - sampledQueries,
    activeQueries,
    fetchingQueries,
    queryObservers,
    mutations: client.getMutationCache().getAll().length,
  };
}

/** 与隔离 preload 只交换固定数值；不读取样式正文、URL、账号或聊天内容。 */
export function installResourceDiagnostics(): () => void {
  const meta = document.createElement('meta');
  meta.id = RESOURCE_DIAGNOSTIC_ID;
  document.head.appendChild(meta);
  const sample = () => {
    const styles = document.querySelectorAll<HTMLStyleElement>(
      '[data-weq-msg-decoration], #weq-dress-skin',
    );
    let rules = 0;
    for (const style of [...styles].slice(0, 512)) rules += style.sheet?.cssRules.length ?? 0;
    meta.content = JSON.stringify({
      ...decorationImageCache.stats(),
      ...collectQueryDiagnostics(diagnosticQueries),
      managedFonts: fontFaces.count(),
      loadingFonts: fontFaces.loading(),
      documentFonts: document.fonts?.size,
      decorationStyles: styles.length,
      decorationRules: rules,
      omittedStyles: Math.max(0, styles.length - 512),
    });
  };
  document.addEventListener(RESOURCE_DIAGNOSTIC_REQUEST, sample);
  return () => {
    document.removeEventListener(RESOURCE_DIAGNOSTIC_REQUEST, sample);
    meta.remove();
  };
}
