import { expect, it, vi } from 'vitest';
import { useStartupProgress } from '../src/renderer/src/state/startupProgress';
import { useAccountSwitch } from '../src/renderer/src/state/accountSwitch';
import {
  installMainWorkspacePreload,
  loadMainWorkspace,
} from '../src/renderer/src/lib/mainWorkspaceLoader';

const fixture = vi.hoisted(() => ({ web: false, loads: vi.fn(), render: vi.fn(() => null) }));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return fixture.web;
  },
}));
vi.mock('../src/renderer/src/lib/target.shared', () => ({
  get IS_WEB() {
    return fixture.web;
  },
}));
vi.mock('../src/renderer/src/views/MainView', () => {
  fixture.loads();
  return { MainView: fixture.render };
});

it('恢复检查和账号选择页等待，进入身份准备时开始读取工作区且不提前挂载', async () => {
  fixture.web = true;
  useStartupProgress.setState({ stage: 'resources' });
  useAccountSwitch.setState({ active: false });
  const stop = installMainWorkspacePreload();
  try {
    useStartupProgress.setState({ stage: 'restore' });
    useStartupProgress.setState({ stage: 'account' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.loads).not.toHaveBeenCalled();
    useStartupProgress.setState({ stage: 'identity' });
    const first = loadMainWorkspace();
    useAccountSwitch.setState({ active: true });
    expect(loadMainWorkspace()).toBe(first);
    expect((await first).default).toBe(fixture.render);
    expect(fixture.loads).toHaveBeenCalledOnce();
    expect(fixture.render).not.toHaveBeenCalled();
  } finally {
    stop();
    fixture.web = false;
    useAccountSwitch.setState({ active: false });
    useStartupProgress.setState({ stage: 'resources' });
  }
});
