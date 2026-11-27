import { DEFAULT_HOME_SETTINGS } from '@weq/service/home-settings';
import { useSyncExternalStore } from 'react';
import { rpcFixture } from './trpc.stub';

export { client, trpc } from './trpc.stub';

const params = new URLSearchParams(location.search);
const mode = params.get('show');
const phaseEvent = 'weq-home-fixture-phase';
let phase = params.has('delayed') ? 0 : 3;
window.addEventListener(phaseEvent, (event) => {
  phase = (event as CustomEvent<number>).detail;
});
function subscribePhase(listener: () => void) {
  window.addEventListener(phaseEvent, listener);
  return () => window.removeEventListener(phaseEvent, listener);
}
const usePhase = () => useSyncExternalStore(subscribePhase, () => phase);

export function useContactQqShow() {
  return {
    data: {
      hasShow: Boolean(usePhase() >= 1 && mode && mode !== 'none'),
      url: '/fixture-qqshow.png',
      expiresAt: 1,
    },
  };
}

rpcFixture.set('bootstrap.getSettings.useQuery', () => ({
  data: {
    home: { ...DEFAULT_HOME_SETTINGS, preferQqShow: mode !== 'off' },
  },
}));
rpcFixture.set('account.getHomeDress.useQuery', () => ({
  data: {
    cardVideoUrl: '/fixture.webm',
    tags:
      usePhase() >= 2
        ? ['音乐', '电影', '旅行', '阅读', '摄影', '运动', '游戏', '生活', '美食', '快乐']
        : [],
  },
}));
rpcFixture.set('account.sampleHitokoto.useQuery', () => ({
  data:
    usePhase() < 3
      ? []
      : [
          {
            text: '用一段足够长的合成文字观察逐字显示与换行期间背景的位置是否保持稳定。'.repeat(3),
            from: '合成测试',
          },
        ],
}));
