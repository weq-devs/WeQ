import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { nextPkgrel, releaseHashes, renderPkgbuild, renderSrcinfo } from './publish-aur.mjs';

const template = readFileSync(new URL('../packaging/aur/PKGBUILD.in', import.meta.url), 'utf8');
const HASHES = {
  x86_64: 'a'.repeat(64),
  aarch64: 'b'.repeat(64),
  weqSh: 'c'.repeat(64),
  weqDesktop: 'd'.repeat(64),
};

test('从 Release 资产里取出两个架构的 sha256', () => {
  const assets = [
    { name: 'weQ-2.6.0-linux-x64.tar.gz', digest: `sha256:${HASHES.x86_64}` },
    { name: 'weQ-2.6.0-linux-arm64.tar.gz', digest: `sha256:${HASHES.aarch64}` },
    { name: 'weQ-2.6.0-linux-x86_64.AppImage', digest: 'sha256:ignored' },
  ];
  assert.deepEqual(releaseHashes(assets, '2.6.0'), {
    x86_64: HASHES.x86_64,
    aarch64: HASHES.aarch64,
  });
});

test('缺少产物或 digest 时拒绝生成', () => {
  assert.throws(() => releaseHashes([], '2.6.0'), /缺少产物/);
  assert.throws(
    () =>
      releaseHashes(
        [
          { name: 'weQ-2.6.0-linux-x64.tar.gz', digest: null },
          { name: 'weQ-2.6.0-linux-arm64.tar.gz', digest: `sha256:${HASHES.aarch64}` },
        ],
        '2.6.0',
      ),
    /未提供 .* sha256 digest/,
  );
});

test('模板渲染后没有残留占位符', () => {
  const rendered = renderPkgbuild(template, { version: '2.6.0', hashes: HASHES });
  assert.equal(/@[A-Z0-9_]+@/.test(rendered), false);
  assert.match(rendered, /^pkgver=2\.6\.0$/m);
  assert.ok(rendered.includes(`'${HASHES.x86_64}'`));
  assert.ok(rendered.includes(`'${HASHES.aarch64}'`));
  assert.ok(rendered.includes(`'${HASHES.weqSh}'`));
  assert.ok(rendered.includes(`'${HASHES.weqDesktop}'`));
});

test('本地辅助文件列在 source 里，否则 makepkg 找不到 $srcdir 里的副本', () => {
  const rendered = renderPkgbuild(template, { version: '2.6.0', hashes: HASHES });
  for (const arch of ['x86_64', 'aarch64']) {
    const body = new RegExp(`^source_${arch}=\\(([\\s\\S]*?)^\\)`, 'm').exec(rendered)?.[1] ?? '';
    assert.match(body, /"weq\.sh"/);
    assert.match(body, /"weq\.desktop"/);
  }
  // 三个 source 条目对应三个哈希，数量对不上 makepkg 会直接报错。
  for (const arch of ['x86_64', 'aarch64']) {
    const sums = new RegExp(`^sha256sums_${arch}=\\(([^)]*)\\)$`, 'm').exec(rendered)?.[1] ?? '';
    assert.equal([...sums.matchAll(/'([a-f0-9]{64})'/g)].length, 3);
  }
});

test('源码地址指向 tar.gz 而不是 AppImage，且用 pkgver 变量', () => {
  const rendered = renderPkgbuild(template, { version: '2.6.0', hashes: HASHES });
  // PKGBUILD 里写变量，升级时只需要改 pkgver 一行。
  assert.match(rendered, /releases\/download\/v\$\{pkgver\}\/weQ-\$\{pkgver\}-linux-x64\.tar\.gz/);
  assert.match(
    rendered,
    /releases\/download\/v\$\{pkgver\}\/weQ-\$\{pkgver\}-linux-arm64\.tar\.gz/,
  );
  assert.equal(rendered.includes('.AppImage'), false);
});

test('.SRCINFO 覆盖 AUR 需要的字段', () => {
  const srcinfo = renderSrcinfo(renderPkgbuild(template, { version: '2.6.0', hashes: HASHES }));
  assert.match(srcinfo, /^pkgbase = weq-bin$/m);
  assert.match(srcinfo, /^\tpkgver = 2\.6\.0$/m);
  assert.match(srcinfo, /^\tarch = x86_64$/m);
  assert.match(srcinfo, /^\tarch = aarch64$/m);
  assert.match(srcinfo, /^\tlicense = CC-BY-NC-SA-4\.0$/m);
  assert.match(srcinfo, /^\tdepends = gtk3$/m);
  // 字段顺序照抄 makepkg：install 在 url 之后、arch 之前。
  assert.ok(srcinfo.indexOf('\tinstall =') < srcinfo.indexOf('\tarch ='));
  assert.match(srcinfo, /^\tprovides = weq$/m);
  // makepkg --printsrcinfo 输出的是展开后的裸 URL（文件名由 makepkg 从末段取）。
  assert.match(
    srcinfo,
    /^\tsource_x86_64 = https:\/\/github\.com\/weq-devs\/WeQ\/releases\/download\/v2\.6\.0\/weQ-2\.6\.0-linux-x64\.tar\.gz$/m,
  );
  assert.match(srcinfo, /^\tsource_x86_64 = weq\.sh$/m);
  assert.match(srcinfo, new RegExp(`^\\tsha256sums_aarch64 = ${HASHES.aarch64}$`, 'm'));
  assert.match(srcinfo, /^\tinstall = weq-bin\.install$/m);
  assert.match(srcinfo, /^pkgname = weq-bin$/m);
});

test('pkgver 变化回到 pkgrel=1，同版本内容变化递增 pkgrel', () => {
  const old = renderPkgbuild(template, { version: '2.6.0', hashes: HASHES });
  const next = renderPkgbuild(template, { version: '2.7.0', hashes: HASHES });
  assert.equal(nextPkgrel(old, next), 1);

  // PKGBUILD 里写的是 `${pkgver}` 变量，所以只有版本号变、正文不变时
  // 渲染结果完全一样 —— 用哈希变化来模拟「同版本重发」。
  const rebuilt = renderPkgbuild(template, {
    version: '2.6.0',
    hashes: { x86_64: 'c'.repeat(64), aarch64: HASHES.aarch64 },
  });
  assert.equal(nextPkgrel(old, rebuilt), 2);

  const bumped = old.replace(/^pkgrel=1$/m, 'pkgrel=3');
  assert.equal(nextPkgrel(bumped, rebuilt), 4);
});

test('内容完全一致时保持原 pkgrel', () => {
  const rendered = renderPkgbuild(template, { version: '2.6.0', hashes: HASHES });
  assert.equal(nextPkgrel(rendered, rendered), 1);
});
