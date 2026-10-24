import { dirname, join, basename } from 'node:path';
import { statSync } from 'node:fs';
import { readJsonFile, writeJsonFileAtomic } from '@weq/service';

export class DialogLocations {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    const raw = readJsonFile(this.file);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry) => typeof entry[1] === 'string'));
  }

  directory(key: string): string | undefined {
    let path = this.read()[key];
    while (path) {
      try {
        if (statSync(path).isDirectory()) return path;
      } catch {
        // 外盘未挂载或旧目录已迁移时退到仍存在的父目录。
      }
      const parent = dirname(path);
      if (parent === path) return undefined;
      path = parent;
    }
    return undefined;
  }

  savePath(key: string, defaultName: string): string {
    const directory = this.directory(key);
    return directory ? join(directory, basename(defaultName)) : defaultName;
  }

  remember(key: string, path: string, isDirectory = false): void {
    const entries = this.read();
    entries[key] = isDirectory ? path : dirname(path);
    writeJsonFileAtomic(this.file, entries);
  }
}
