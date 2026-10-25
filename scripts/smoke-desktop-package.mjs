import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';

// 用 ELECTRON_RUN_AS_NODE=1 electron 执行，不启动应用、网络服务或用户资料。
assert.ok(process.versions.electron, '请使用 Electron 的 Node 模式执行此检查');
assert.ok(process.argv[2], '请传入打包产物的 Resources/resources 目录');
const resources = resolve(process.argv[2]);
const asar = join(resources, 'app.asar');
const require = createRequire(join(asar, 'package.json'));
const workerRequire = createRequire(join(resources, 'out/main/ocrWorker.mjs'));

function packagedModule(resolver, name) {
  const file = resolver.resolve(name);
  assert.ok(file.startsWith(`${resources}${sep}`), `${name} 意外回退到了开发环境：${file}`);
  assert.ok(existsSync(file), `缺少运行依赖 ${name}`);
  return file;
}

for (const name of ['react-icons', 'mermaid', 'shiki', 'lottie-web', 'react-dom', 'streamdown']) {
  assert.equal(existsSync(join(asar, 'node_modules', name)), false, `不应携带前端原始包 ${name}`);
}
assert.ok(existsSync(join(asar, 'out/renderer/index.html')));
assert.ok(readdirSync(join(asar, 'out/renderer/assets')).length > 0);
assert.equal(existsSync(join(asar, 'node_modules/exceljs/dist')), false);
for (const name of [
  'electron-trpc/main',
  '@electron-toolkit/preload',
  '@electron-toolkit/utils',
  '@trpc/server',
  '@trpc/client',
  '@modelcontextprotocol/sdk/server/mcp.js',
  'ws',
]) {
  packagedModule(require, name);
}

const ExcelJS = require('exceljs');
const workbook = new ExcelJS.Workbook();
workbook.addWorksheet('smoke').addRow(['weq', 42]);
const output = new PassThrough();
const chunks = [];
output.on('data', (chunk) => chunks.push(chunk));
const streaming = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output });
const worksheet = streaming.addWorksheet('smoke');
worksheet.addRow(['weq', 42]).commit();
worksheet.commit();
await streaming.commit();
const zip = await require('jszip').loadAsync(Buffer.concat(chunks));
assert.ok((await zip.file('xl/worksheets/sheet1.xml').async('string')).includes('<v>42</v>'));
assert.ok((await workbook.xlsx.writeBuffer()).length > 0);
assert.ok((await workbook.csv.writeBuffer()).length > 0);
console.log('PASS ExcelJS 流式 XLSX/CSV 导出与工作表内容校验');

const sharp = require('sharp');
const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } })
  .resize(4, 4)
  .png()
  .toBuffer();
assert.equal((await sharp(png).metadata()).width, 4);
const { Resvg } = require('@resvg/resvg-js');
assert.ok(
  new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
  )
    .render()
    .asPng().length > 0,
);
console.log('PASS sharp 缩图和 resvg 原生渲染');

const satori = require('satori').default;
const svg = await satori(
  { type: 'div', props: { style: { width: 8, height: 8, backgroundColor: 'red' } } },
  { width: 8, height: 8, fonts: [] },
);
assert.ok(svg.includes('<svg'));
console.log('PASS satori 封面渲染依赖');

if (process.platform === 'darwin' && process.arch === 'x64') {
  console.log('SKIP Intel Mac：当前 ONNX Runtime 未提供该平台绑定，与现有产品限制一致');
} else {
  packagedModule(workerRequire, 'onnxruntime-node');
  packagedModule(workerRequire, 'onnxruntime-common');
  packagedModule(workerRequire, '@huggingface/tokenizers');
  packagedModule(workerRequire, '@receptron/laya');
  const ort = workerRequire('onnxruntime-node');
  assert.equal(typeof ort.InferenceSession.create, 'function');
  const tensor = new ort.Tensor('float32', new Float32Array([1]), [1]);
  assert.equal(tensor.data[0], 1);
  const { Laya } = await import(pathToFileURL(workerRequire.resolve('@receptron/laya')).href);
  assert.equal(typeof Laya, 'function');
  console.log('PASS OCR/意图分析子进程依赖加载（不下载模型）');
}

const sherpa = require('sherpa-onnx-node');
assert.equal(typeof sherpa.OfflineRecognizer, 'function');
const bindingPlatform = process.platform === 'win32' ? 'win' : process.platform;
const binding = `sherpa-onnx-${bindingPlatform}-${process.arch}`;
assert.ok(existsSync(join(resources, 'app.asar.unpacked/node_modules', binding)));
console.log('PASS sherpa 语音引擎原生绑定加载（不下载模型）');
console.log('PASS 桌面包瘦身冒烟完成');
