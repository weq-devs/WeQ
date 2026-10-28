import { expect, it } from 'vitest';
import {
  collectQueryDiagnostics,
  registerDiagnosticQueries,
  installResourceDiagnostics,
} from '../src/renderer/src/lib/resourceDiagnostics';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  RESOURCE_DIAGNOSTIC_ID,
  RESOURCE_DIAGNOSTIC_REQUEST,
  normalizeResourceSample,
} from '../src/shared/renderer_diagnostics';

it('按需提供固定数值，不记录样式正文，停止后移除监听和节点', () => {
  const style = document.createElement('style');
  style.dataset.weqMsgDecoration = 'secret-id';
  style.textContent = '.secret { color: red; }';
  document.head.appendChild(style);
  const stop = installResourceDiagnostics();
  try {
    document.dispatchEvent(new Event(RESOURCE_DIAGNOSTIC_REQUEST));
    const raw = document.getElementById(RESOURCE_DIAGNOSTIC_ID)!.getAttribute('content')!;
    expect(raw.length).toBeLessThan(2048);
    expect(raw).not.toContain('secret');
    expect(normalizeResourceSample(JSON.parse(raw))).toMatchObject({
      decorationStyles: 1,
      decorationRules: 1,
      totalPendingImages: 0,
    });
  } finally {
    stop();
    style.remove();
  }
  document.dispatchEvent(new Event(RESOURCE_DIAGNOSTIC_REQUEST));
  expect(document.getElementById(RESOURCE_DIAGNOSTIC_ID)).toBeNull();
});

it('查询缓存仅记录有界计数与观察者；卸载后不保留 QueryClient', () => {
  const client = new QueryClient({
    defaultOptions: { queries: { cacheTime: Infinity, staleTime: Infinity } },
  });
  client.setQueryData(['private-query'], { secret: 'private-data' });
  const observer = new QueryObserver(client, { queryKey: ['private-query'] });
  const unsubscribe = observer.subscribe(() => {});
  const unregister = registerDiagnosticQueries(client);
  const stop = installResourceDiagnostics();
  try {
    document.dispatchEvent(new Event(RESOURCE_DIAGNOSTIC_REQUEST));
    const raw = document.getElementById(RESOURCE_DIAGNOSTIC_ID)!.getAttribute('content')!;
    expect(JSON.parse(raw)).toMatchObject({
      queries: 1,
      activeQueries: 1,
      queryObservers: 1,
      mutations: 0,
    });
    expect(raw).not.toContain('private');
    for (let i = 0; i < 520; i++) client.setQueryData(['fixture', i], i);
    expect(collectQueryDiagnostics(client)).toMatchObject({
      queries: 521,
      sampledQueries: 512,
      omittedQueries: 9,
    });
    unregister();
    document.dispatchEvent(new Event(RESOURCE_DIAGNOSTIC_REQUEST));
    expect(
      JSON.parse(document.getElementById(RESOURCE_DIAGNOSTIC_ID)!.getAttribute('content')!),
    ).not.toHaveProperty('queries');
  } finally {
    stop();
    unregister();
    unsubscribe();
    client.clear();
  }
});
