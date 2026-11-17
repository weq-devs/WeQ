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

it('Remote 恢复检查时并行预载，桌面仍等待身份阶段，打开与切号复用请求且不提前挂载', async () => {
  useStartupProgress.setState({ stage: 'resources' });
  useAccountSwitch.setState({ active: false });
  const stop = installMainWorkspacePreload();
  try {
    expect(fixture.loads).not.toHaveBeenCalled();
    useStartupProgress.setState({ stage: 'restore' });
    expect(fixture.loads).not.toHaveBeenCalled();
    fixture.web = true;
    useStartupProgress.setState({ stage: 'restore' });
    await vi.waitFor(() => expect(fixture.loads).toHaveBeenCalledOnce());
    useStartupProgress.setState({ stage: 'account' });
    expect(fixture.loads).toHaveBeenCalledOnce();
    useStartupProgress.setState({ stage: 'identity' });
    const first = loadMainWorkspace();
    useAccountSwitch.setState({ active: true });
    const second = loadMainWorkspace();
    expect(second).toBe(first);
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
