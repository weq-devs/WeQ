import prepareRemoteNetwork from './package-remote-network.mjs';
import { prepareEnhancementEngines } from './prepare-enhancement-engines.mjs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { Arch } = require('electron-builder');

export default async function prepareDesktopPackage(context) {
  prepareRemoteNetwork(context);
  await prepareEnhancementEngines({
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
  });
}
