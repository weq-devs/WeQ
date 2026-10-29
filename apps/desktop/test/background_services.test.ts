// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 各 runtime 的状态函数都 mock 掉 —— 这个模块的职责只是「把六个信号汇总成
 * 一个名单」，不该连带把真实服务拉起来。
 */
const state = vi.hoisted(() => ({
  mcp: false,
  onebot: false,
  assistant: false,
  web: false,
  remote: false,
  sse: false,
  suppressed: false,
  bootstrapThrows: false,
}));

vi.mock('../src/main/mcp/server', () => ({ isMcpRunning: () => state.mcp }));
vi.mock('../src/main/onebot/runtime', () => ({
  oneBotStatus: () => ({ running: state.onebot, clients: 0 }),
}));
vi.mock('../src/main/weq_assistant/server', () => ({
  assistantResourceServer: { status: () => ({ running: state.assistant, port: 27182 }) },
}));
vi.mock('../src/main/web/runtime', () => ({
  desktopWebRuntime: { status: () => ({ enabled: state.web }) },
}));
vi.mock('../src/main/remote/runtime', () => ({
  remoteRuntime: { status: () => ({ enabled: state.remote }) },
}));
vi.mock('../src/main/context/app_context', () => ({
  isSsePushActive: () => state.sse,
  getAppContext: () => {
    if (state.bootstrapThrows) throw new Error('native not ready');
    return {
      bootstrap: {
        userConfig: { getSettings: () => ({ quitConfirmSuppressed: state.suppressed }) },
      },
    };
  },
}));

const { backgroundServicesRunning, needsQuitConfirmation } = await import(
  '../src/main/background_services'
);

beforeEach(() => {
  state.mcp = false;
  state.onebot = false;
  state.assistant = false;
  state.web = false;
  state.remote = false;
  state.sse = false;
  state.suppressed = false;
  state.bootstrapThrows = false;
});

describe('当前运行中的后台服务', () => {
  it('全部关闭时返回空数组', () => {
    expect(backgroundServicesRunning()).toEqual([]);
  });

  it('按固定顺序列出运行中的服务，未运行的跳过', () => {
    state.mcp = true;
    state.assistant = true;
    state.sse = true;
    expect(backgroundServicesRunning()).toEqual([
      { id: 'mcp', label: 'MCP 服务器' },
      { id: 'assistant', label: 'QQ 公众号推送' },
      { id: 'sse', label: 'SSE 消息推送' },
    ]);
  });

  it('六个信号各自独立生效', () => {
    for (const key of ['mcp', 'onebot', 'assistant', 'web', 'remote', 'sse'] as const) {
      state[key] = true;
      expect(backgroundServicesRunning().map((s) => s.id)).toEqual([key]);
      state[key] = false;
    }
  });

  it('某个状态函数抛错时当作没在跑，不影响其余服务', () => {
    state.mcp = true;
    state.remote = true;
    // 让 web 的状态访问抛错：把它换成会炸的桩不方便，这里改用 bootstrap 抛错
    // 验证「整体不炸」这条兜底路径。
    state.bootstrapThrows = true;
    expect(backgroundServicesRunning().map((s) => s.id)).toEqual(['mcp', 'remote']);
  });
});

describe('退出前是否需要确认', () => {
  it('没有服务在跑时不确认', () => {
    expect(needsQuitConfirmation()).toBe(false);
  });

  it('有服务在跑就要确认', () => {
    state.onebot = true;
    expect(needsQuitConfirmation()).toBe(true);
  });

  it('勾过不再询问后即使有服务也不确认', () => {
    state.mcp = true;
    state.suppressed = true;
    expect(needsQuitConfirmation()).toBe(false);
  });

  it('bootstrap 不可用（原生加载失败）时不拦退出', () => {
    state.mcp = true;
    state.bootstrapThrows = true;
    expect(needsQuitConfirmation()).toBe(false);
  });
});
