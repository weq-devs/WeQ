#!/usr/bin/env python3
"""在专用 Android 模拟器中验证真实 TS、配对与撤销，不使用公共账号。"""
import argparse
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
BUILD = ROOT / '.build'
parser = argparse.ArgumentParser()
parser.add_argument('--serial', default='emulator-5580')
args = parser.parse_args()
sdk = Path(os.environ.get('ANDROID_HOME', Path.home() / 'Library/Android/sdk'))
adb = [str(sdk / 'platform-tools/adb'), '-s', args.serial]


def call(command, **kwargs):
    return subprocess.check_output(list(map(str, command)), **kwargs)


if 'WeQRemote_API36' not in call(adb + ['emu', 'avd', 'name']).decode():
    raise SystemExit('拒绝操作非本轮专用模拟器。')
# 仅调整本项目测试虚拟设备，避免镜像的蓝牙重启和动画拖慢无关测试。
subprocess.run(adb + ['shell', 'svc', 'bluetooth', 'disable'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for setting in ('window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'):
    call(adb + ['shell', 'settings', 'put', 'global', setting, '0'])
with socket.socket() as probe:
    if probe.connect_ex(('127.0.0.1', 45198)) == 0:
        raise SystemExit('45198 已被其他进程占用；未停止或复用其他服务。')
config = BUILD / 'network-test.json'
if config.exists():
    raise SystemExit('已有测试网络配置，请先检查原现场，不覆盖。')
subprocess.run(['go', 'build', '-p', '2', '-o', str(BUILD / 'test-network'), './ios-test-network'], cwd=REPO / 'tools/remote-network', check=True)
env = dict(os.environ, WEQ_REMOTE_TEST_CONFIG=str(config), GOMAXPROCS='2')
processes = []
ports = []
log_path = BUILD / 'integration.log'
with log_path.open('w') as log:
    try:
        processes.append(subprocess.Popen(['pnpm', 'exec', 'tsx', 'apps/ios/scripts/integration-server.ts'], cwd=REPO, env=env, stdout=log, stderr=log, start_new_session=True))
        processes.append(subprocess.Popen([str(BUILD / 'test-network'), '--helper', str(REPO / 'tools/remote-network/weq-remote-network'), '--config', str(config)], cwd=REPO, env=env, stdin=subprocess.PIPE, stdout=log, stderr=log, start_new_session=True))
        deadline = time.monotonic() + 55
        while not config.exists():
            if any(process.poll() is not None for process in processes) or time.monotonic() > deadline:
                raise RuntimeError('隔离 TS 网络未就绪，请查看有界测试日志。')
            time.sleep(.2)
        settings = json.loads(config.read_text())
        ports = [45198, urlparse(settings['control']).port, int(settings['relayPort'])]
        for port in ports:
            call(adb + ['reverse', f'tcp:{port}', f'tcp:{port}'])
        package = 'cn.wata4me.weq.remote.test'
        print(call(adb + ['install', '-r', str(BUILD / 'weq-remote-0.1.0-arm64-test.apk')]).decode())
        for mode in ('no', 'yes'):
            call(adb + ['shell', 'cmd', 'uimode', 'night', mode])
            output = call(adb + ['shell', 'am', 'instrument', '-w', package + '/cn.wata4me.weq.remote.RemoteInstrumentation']).decode()
            print(output)
            if 'PASS:' not in output or 'FAIL:' in output:
                raise RuntimeError('Android 原生集成验证失败')
            screenshot = call(adb + ['exec-out', 'run-as', package, 'cat', 'files/connection.png'])
            (BUILD / ('connected-dark.png' if mode == 'yes' else 'connected-light.png')).write_bytes(screenshot)
            call(adb + ['shell', 'am', 'force-stop', package])
        print('PASS: light/dark native UI; embedded TS; pairing; actual status request; revocation')
    finally:
        subprocess.run(adb + ['shell', 'am', 'force-stop', 'cn.wata4me.weq.remote.test'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(adb + ['shell', 'cmd', 'uimode', 'night', 'auto'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for port in ports:
            subprocess.run(adb + ['reverse', '--remove', f'tcp:{port}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for process in reversed(processes):
            if process.stdin:
                process.stdin.close()
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            process.wait(timeout=12)
if log_path.stat().st_size > 262144:
    raise SystemExit('测试日志超出预期大小，请检查。')
