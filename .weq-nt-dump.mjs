/** 临时排查：加载 nt_helper.node，列出导出，找可单独调用的解密入口。用完即删。 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const p = resolve(process.cwd(), 'native/linux/x64/nt_helper.node');
process.chdir(dirname(p));
const require = createRequire(import.meta.url);
const addon = require(p);
console.log('getInitStatus =', addon.getInitStatus());
console.log('导出函数：');
console.log(Object.keys(addon).sort().join('\n'));
