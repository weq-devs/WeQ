import { resolve } from 'node:path';
import { probeRuntime } from './runtime-deps.mjs';

// 使用短命子进程释放原生 DLL/WASM，再替换目录，避免 Windows 文件锁。
await probeRuntime(resolve(process.argv[2]), process.argv[3]);
