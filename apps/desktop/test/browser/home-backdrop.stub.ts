import { DEFAULT_HOME_SETTINGS } from '@weq/service/home-settings';

const mode = new URLSearchParams(location.search).get('show');
export function useContactQqShow() {
  return {
    data: { hasShow: Boolean(mode && mode !== 'none'), url: '/fixture-qqshow.png', expiresAt: 1 },
  };
}

export const trpc = {
  bootstrap: {
    getSettings: {
      useQuery: () => ({
        data: {
          home: { ...DEFAULT_HOME_SETTINGS, preferQqShow: mode !== 'off' },
        },
      }),
    },
  },
  account: {
    getHomeDress: {
      useQuery: () => ({
        data: {
          cardVideoUrl: '/fixture.webm',
          tags: ['音乐', '电影', '旅行', '阅读', '摄影', '运动', '游戏', '生活', '美食', '快乐'],
        },
      }),
    },
    sampleHitokoto: {
      useQuery: () => ({
        data: [
          {
            text: '用一段足够长的合成文字观察逐字显示与换行期间背景的位置是否保持稳定。'.repeat(3),
            from: '合成测试',
          },
        ],
      }),
    },
  },
};
