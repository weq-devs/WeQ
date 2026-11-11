#!/usr/bin/env node

/**
 * 删除 docs/develop 下文件名带日期的 Markdown，并清理相关引用。
 *
 * 用法：
 *   node scripts/prune-dated-develop-docs.mjs
 *   node scripts/prune-dated-develop-docs.mjs --write
 *
 * 默认只预览。--write 才会改写引用并删除文件。
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');
const DEVELOP = join(DOCS, 'develop');
const NAV = join(DOCS, '.vitepress', 'nav.mts');
const WRITE = process.argv.includes('--write');
const DATE_IN_NAME = /(?:19|20)\d{2}(?:-?\d{2}){2}/;
const LINK_PATTERN = () => /!?\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^)]*["'])?\s*\)/g;

function walk(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.vitepress' || entry.name === 'public') {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, predicate, out);
    } else if (entry.isFile() && predicate(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function resolveDocLink(rawTarget, sourceFile) {
  const cleanTarget = rawTarget.split('#', 1)[0].split('?', 1)[0];
  if (!cleanTarget || /^[a-z][a-z0-9+.-]*:/i.test(cleanTarget) || cleanTarget.startsWith('#')) {
    return null;
  }

  const decoded = decodeURIComponent(cleanTarget);
  let absolute;
  if (decoded.startsWith('/')) {
    absolute = resolve(DOCS, decoded.slice(1));
  } else {
    absolute = resolve(dirname(sourceFile), decoded);
  }
  if (!absolute.endsWith('.md')) absolute += '.md';
  return absolute;
}

const datedDocs = walk(DEVELOP, (name) => name.endsWith('.md') && DATE_IN_NAME.test(name));
const datedDocSet = new Set(datedDocs.map((file) => resolve(file)));

function linksToDatedDoc(rawTarget, sourceFile) {
  const absolute = resolveDocLink(rawTarget, sourceFile);
  return absolute ? datedDocSet.has(absolute) : false;
}

function stripDatedLinks(text, sourceFile) {
  return text.replace(LINK_PATTERN(), (link, label, target) =>
    linksToDatedDoc(target, sourceFile) ? label : link,
  );
}

function cleanIndex(text, sourceFile) {
  const lines = [];
  for (const line of text.split('\n')) {
    const links = [...line.matchAll(LINK_PATTERN())];
    const datedLinks = links.filter((match) => linksToDatedDoc(match[2], sourceFile));
    if (datedLinks.length === 0) {
      lines.push(line);
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      const survivingDevelopLinks = links.filter((match) => {
        if (linksToDatedDoc(match[2], sourceFile)) return false;
        const absolute = resolveDocLink(match[2], sourceFile);
        return absolute?.startsWith(`${DEVELOP}${sep}`);
      });
      if (survivingDevelopLinks.length === 0) continue;

      const indent = line.match(/^\s*/)?.[0] ?? '';
      lines.push(`${indent}- ${survivingDevelopLinks.map((match) => match[0]).join('、')}`);
      continue;
    }

    lines.push(stripDatedLinks(line, sourceFile));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function cleanNav(text, sourceFile) {
  return text
    .split('\n')
    .filter((line) => {
      const match = line.match(/\blink:\s*['"]([^'"]+)['"]/);
      return !(match && linksToDatedDoc(match[1], sourceFile));
    })
    .join('\n');
}

const markdownFiles = walk(DOCS, (name) => name.endsWith('.md'));
const changed = [];

for (const file of markdownFiles) {
  if (datedDocSet.has(resolve(file))) continue;
  const before = readFileSync(file, 'utf8');
  const after =
    resolve(file) === resolve(DEVELOP, 'index.md')
      ? cleanIndex(before, file)
      : stripDatedLinks(before, file);
  if (after !== before) changed.push({ file, after });
}

if (existsSync(NAV)) {
  const before = readFileSync(NAV, 'utf8');
  const after = cleanNav(before, NAV);
  if (after !== before) changed.push({ file: NAV, after });
}

for (const file of datedDocs) {
  if (!resolve(file).startsWith(`${DEVELOP}${sep}`)) {
    throw new Error(`拒绝删除 docs/develop 之外的文件：${relative(ROOT, file)}`);
  }
}

console.log(`${WRITE ? '将执行' : '预览'}：删除 ${datedDocs.length} 个日期命名文档`);
console.log(`${WRITE ? '将执行' : '预览'}：更新 ${changed.length} 个文件中的引用`);

if (!WRITE) {
  if (datedDocs.length > 0)
    console.log(`\n待删除文件：\n${datedDocs.map((file) => relative(ROOT, file)).join('\n')}`);
  if (changed.length > 0)
    console.log(`\n待更新文件：\n${changed.map(({ file }) => relative(ROOT, file)).join('\n')}`);
  console.log('\n确认无误后追加 --write 执行。');
  process.exit(0);
}

for (const { file, after } of changed) writeFileSync(file, after);
for (const file of datedDocs) rmSync(file);

console.log('完成。');
