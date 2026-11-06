// @vitest-environment node
import { expect, test } from 'vitest';
import { findMacLaunchApplication } from '../src/main/mac_launch_application';

test('沿真实父进程找到终端来源，不把当前 Electron 当作启动来源', () => {
  expect(
    findMacLaunchApplication(
      `
1 0 /sbin/launchd
10 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
20 10 /bin/zsh
30 20 /opt/node
40 30 /fixture/Electron.app/Contents/MacOS/Electron
`,
      40,
    ),
  ).toBe('/System/Applications/Utilities/Terminal.app');
});
test('保留带空格路径；父进程退出、断链或循环时不猜测来源', () => {
  expect(
    findMacLaunchApplication(
      '10 1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n20 10 /opt/node\n30 20 /fixture/Electron.app/Contents/MacOS/Electron',
      30,
    ),
  ).toBe('/Applications/Visual Studio Code.app');
  expect(
    findMacLaunchApplication('40 1 /fixture/Electron.app/Contents/MacOS/Electron', 40),
  ).toBeNull();
  expect(
    findMacLaunchApplication(
      '40 30 /fixture/Electron.app/Contents/MacOS/Electron\n30 40 /opt/node',
      40,
    ),
  ).toBeNull();
});
