import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const version = require('playwright/package.json').version;
const engines = await import('playwright');

if (version !== manifest.devDependencies.playwright) {
  throw new Error(
    '[browser:environment] Playwright 版本不匹配，请运行 pnpm install --frozen-lockfile',
  );
}

export async function launchBrowser(name) {
  if (!['chromium', 'webkit', 'firefox'].includes(name)) {
    throw new Error(`[browser:environment] 未知浏览器：${name}`);
  }
  const engine = engines[name];
  const executable = engine.executablePath();
  console.log(`[browser:environment] playwright=${version} engine=${name} path=${executable}`);
  try {
    await access(executable);
    return await engine.launch({ headless: true });
  } catch (cause) {
    throw new Error(
      `[browser:environment] ${name} 启动失败，请运行 pnpm exec playwright install ${name}`,
      { cause },
    );
  }
}

async function checkBrowsers(names) {
  for (const name of names) {
    const browser = await launchBrowser(name);
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.setContent('<title>WeQ browser check</title>');
        if ((await page.title()) !== 'WeQ browser check') throw new Error('页面内容检查失败');
        console.log(`[browser:environment] ${name} ${browser.version()} context/page OK`);
      } finally {
        await context.close();
      }
    } catch (cause) {
      throw new Error(`[browser:environment] ${name} 创建或操作页面失败`, { cause });
    } finally {
      await browser.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkBrowsers(process.argv.length > 2 ? process.argv.slice(2) : ['chromium', 'webkit']);
}
