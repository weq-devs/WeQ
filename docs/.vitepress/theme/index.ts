import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import AvatarPathCalculator from './components/AvatarPathCalculator.vue';
import QqDataPathExplorer from './components/QqDataPathExplorer.vue';
import AndroidDbKeyCalculator from './components/AndroidDbKeyCalculator.vue';
import GproKeyCalculator from './components/GproKeyCalculator.vue';
import GuidCalculator from './components/GuidCalculator.vue';
import MarketFaceKeyCalculator from './components/MarketFaceKeyCalculator.vue';
import MarketFaceImageDecoder from './components/MarketFaceImageDecoder.vue';
import LoginDbInspector from './components/LoginDbInspector.vue';
import './style/tools.css';

/**
 * 旧的 `/principles/**` 已经被合并进 `/develop/principles/**`。
 *
 * 静态托管（GitHub Pages）没有服务端跳转，深链接会先落到 404 应用壳，再由这里
 * 在路由层替换掉地址，搜索收录的旧链接因此仍然可用。
 */
const LEGACY_PREFIXES: [string, string][] = [['/principles/', '/develop/principles/']];

function redirectLegacy(path: string): string | null {
  if (path === '/principles') return '/develop/principles';
  for (const [from, to] of LEGACY_PREFIXES) {
    if (path.startsWith(from)) return to + path.slice(from.length);
  }
  return null;
}

export default {
  extends: DefaultTheme,

  enhanceApp({ app, router }) {
    app.component('AvatarPathCalculator', AvatarPathCalculator);
    app.component('QqDataPathExplorer', QqDataPathExplorer);
    app.component('AndroidDbKeyCalculator', AndroidDbKeyCalculator);
    app.component('GproKeyCalculator', GproKeyCalculator);
    app.component('GuidCalculator', GuidCalculator);
    app.component('MarketFaceKeyCalculator', MarketFaceKeyCalculator);
    app.component('MarketFaceImageDecoder', MarketFaceImageDecoder);
    app.component('LoginDbInspector', LoginDbInspector);

    // 服务端渲染阶段没有真正的 vue-router 实例，只处理浏览器。
    if (typeof window === 'undefined' || typeof router?.afterEach !== 'function') return;
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    const current = window.location.pathname.startsWith(base)
      ? window.location.pathname.slice(base.length) || '/'
      : window.location.pathname;
    const initial = redirectLegacy(current);
    if (initial) window.location.replace(`${base}${initial}`);
    router.afterEach((to) => {
      const target = redirectLegacy(to.path);
      if (target && target !== to.path) void router.replace(target);
    });
  },
} satisfies Theme;
