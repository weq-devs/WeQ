#!/usr/bin/env python3
"""用现有 SDK 与固定版本 gomobile 构建最小 APK，不下载整套 IDE/Gradle。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / '.build'
ZXING_HASH = '8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82'
ANDROID = '{http://schemas.android.com/apk/res/android}'
ET.register_namespace('android', ANDROID[1:-1])


def run(command, cwd=ROOT, env=None):
    subprocess.run([str(value) for value in command], cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--test', action='store_true', help='单独的本机集成测试 APK，不可作为产品交付')
    parser.add_argument('--skip-network', action='store_true', help='复用已构建 AAR；不用于首次构建')
    args = parser.parse_args()
    sdk = Path(os.environ.get('ANDROID_HOME', Path.home() / 'Library/Android/sdk'))
    ndk = Path(os.environ.get('ANDROID_NDK_HOME', sdk / 'ndk/28.2.13676358'))
    tools = sdk / 'build-tools/36.0.0'
    android_jar = sdk / 'platforms/android-36/android.jar'
    for path in (tools / 'aapt2', android_jar, ndk):
        if not path.exists():
            raise SystemExit(f'缺少本机 Android 工具：{path}')
    (BUILD / 'tools').mkdir(parents=True, exist_ok=True)
    (BUILD / 'deps').mkdir(exist_ok=True)
    zxing = BUILD / 'deps/zxing-core-3.5.3.jar'
    if not zxing.exists():
        with urllib.request.urlopen('https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar', timeout=60) as response:
            data = response.read(1_048_576)
        if hashlib.sha256(data).hexdigest() != ZXING_HASH:
            raise SystemExit('ZXing 校验失败')
        zxing.write_bytes(data)
    if hashlib.sha256(zxing.read_bytes()).hexdigest() != ZXING_HASH:
        raise SystemExit('本地 ZXing 文件与固定版本不符')
    env = dict(os.environ, ANDROID_HOME=str(sdk), ANDROID_NDK_HOME=str(ndk), GOBIN=str(BUILD / 'tools'), GOMAXPROCS='2', GOFLAGS='-p=2')
    env['PATH'] = str(BUILD / 'tools') + os.pathsep + env['PATH']
    if not args.skip_network:
        run(['go', 'install', '-p', '2', 'golang.org/x/mobile/cmd/gomobile', 'golang.org/x/mobile/cmd/gobind'], ROOT / 'network', env)
        run([BUILD / 'tools/gomobile', 'bind', '-target=android/arm64', '-androidapi=26', '-ldflags=-s -w', '-o', BUILD / 'network.aar', '.'], ROOT / 'network', env)
    aar_root = BUILD / 'aar'
    aar_root.mkdir(exist_ok=True)
    with zipfile.ZipFile(BUILD / 'network.aar') as archive:
        archive.extractall(aar_root)
    variant = BUILD / ('test' if args.test else 'app')
    variant.mkdir(exist_ok=True)
    classes = variant / 'classes'
    classes.mkdir(exist_ok=True)
    generated = variant / 'generated/cn/wata4me/weq/remote'
    generated.mkdir(parents=True, exist_ok=True)
    (generated / 'BuildConfig.java').write_text('package cn.wata4me.weq.remote; public final class BuildConfig { public static final boolean TESTING = ' + str(args.test).lower() + '; }\n')
    manifest = ET.parse(ROOT / 'AndroidManifest.xml')
    if args.test:
        manifest.getroot().set('package', 'cn.wata4me.weq.remote.test')
        application = manifest.getroot().find('application')
        application.set(ANDROID + 'debuggable', 'true')
        application.set(ANDROID + 'usesCleartextTraffic', 'true')
        ET.SubElement(manifest.getroot(), 'instrumentation', {ANDROID + 'name': 'cn.wata4me.weq.remote.RemoteInstrumentation', ANDROID + 'targetPackage': 'cn.wata4me.weq.remote.test'})
    manifest.write(variant / 'AndroidManifest.xml', encoding='utf-8', xml_declaration=True)
    resource_zip = variant / 'resources.zip'
    run([tools / 'aapt2', 'compile', '--dir', ROOT / 'res', '-o', resource_zip])
    unsigned = variant / 'unsigned.apk'
    run([tools / 'aapt2', 'link', '-I', android_jar, '--manifest', variant / 'AndroidManifest.xml', '--min-sdk-version', '26', '--target-sdk-version', '36', '-o', unsigned, resource_zip])
    sources = list((ROOT / 'src').rglob('*.java')) + [generated / 'BuildConfig.java']
    if args.test:
        sources += list((ROOT / 'testsrc').rglob('*.java'))
    classpath = os.pathsep.join(map(str, [android_jar, aar_root / 'classes.jar', zxing]))
    run(['javac', '-encoding', 'UTF-8', '--release', '8', '-classpath', classpath, '-d', classes, *sources])
    jar = variant / 'app.jar'
    run(['jar', 'cf', jar, '-C', classes, '.'])
    dex = variant / 'dex'
    dex.mkdir(exist_ok=True)
    run([tools / 'd8', '--min-api', '26', '--lib', android_jar, '--output', dex, jar, aar_root / 'classes.jar', zxing])
    licenses = ["WeQ Remote Android 0.1.0\nTailscale 1.104.1 + Go mobile + ZXing 3.5.3\n"]
    go_root = Path(subprocess.check_output(['go', 'env', 'GOROOT'], env=env).decode().strip())
    go_license = next((path for path in (go_root / 'LICENSE', go_root.parent / 'LICENSE') if path.is_file()), None)
    if go_license is None:
        raise SystemExit('未找到 Go 发行版许可证，未生成不完整的分发包。')
    licenses.append('Go runtime\n' + go_license.read_text())
    listing = subprocess.check_output(['go', 'list', '-m', '-json', 'all'], cwd=ROOT / 'network', env=env).decode()
    decoder = json.JSONDecoder()
    while listing.strip():
        module, end = decoder.raw_decode(listing.lstrip())
        listing = listing.lstrip()[end:]
        directory = module.get('Dir')
        if directory:
            for name in ('LICENSE', 'LICENSE.txt', 'COPYING'):
                candidate = Path(directory) / name
                if candidate.is_file() and candidate.stat().st_size < 262144:
                    licenses.append('\n\n' + module['Path'] + ' ' + module.get('Version', '') + '\n' + candidate.read_text(errors='replace'))
                    break
    apache = ('Apache License, Version 2.0\nhttps://www.apache.org/licenses/LICENSE-2.0\nZXing: Copyright ZXing authors\n')
    licenses.append(apache)
    with zipfile.ZipFile(unsigned, 'a') as archive:
        for path in sorted(dex.glob('*.dex')):
            archive.write(path, path.name)
        for path in (aar_root / 'jni/arm64-v8a').glob('*.so'):
            archive.write(path, 'lib/arm64-v8a/' + path.name, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
        archive.writestr('assets/THIRD_PARTY_LICENSES.txt', '\n'.join(licenses))
        project_license = ROOT.parents[1] / 'LICENSE'
        if project_license.is_file():
            archive.write(project_license, 'assets/WEQ_LICENSE.txt')
    aligned = variant / 'aligned.apk'
    run([tools / 'zipalign', '-P', '16', '-f', '4', unsigned, aligned])
    key = Path.home() / '.android/debug.keystore'
    if not key.exists():
        key.parent.mkdir(exist_ok=True)
        run(['keytool', '-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'])
    output = BUILD / ('weq-remote-0.1.0-arm64-test.apk' if args.test else 'weq-remote-0.1.0-arm64.apk')
    run([tools / 'apksigner', 'sign', '--ks', key, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', output, aligned])
    run([tools / 'apksigner', 'verify', '--verbose', output])
    print('APK:', output)


if __name__ == '__main__':
    main()
