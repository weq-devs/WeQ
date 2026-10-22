#!/usr/bin/env python3
"""在指定、核实 UUID 的外盘上创建或启动本项目的独立 AVD。"""
import argparse
import configparser
import os
from pathlib import Path
import plistlib
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--volume', required=True)
parser.add_argument('--uuid', required=True)
parser.add_argument('--create', action='store_true')
args = parser.parse_args()
info = plistlib.loads(subprocess.check_output(['diskutil', 'info', '-plist', args.volume]))
if info.get('VolumeUUID', '').upper() != args.uuid.upper() or info.get('MountPoint') != args.volume:
    raise SystemExit('外盘 UUID 或真实挂载点不匹配，未创建替代虚拟机目录。')
sdk = Path(os.environ.get('ANDROID_HOME', Path.home() / 'Library/Android/sdk'))
guard = Path.home() / 'Projects/local-portal/external_disk_guard.py'
avd_path = str(Path(args.volume) / 'Runtime/WeQRemote/android/avd/WeQRemote_API36.avd')
if args.create:
    command = [sdk / 'cmdline-tools/latest/bin/avdmanager', 'create', 'avd', '--name', 'WeQRemote_API36',
               '--package', 'system-images;android-36;google_apis;arm64-v8a', '--device', 'pixel_7',
               '--path', avd_path]
else:
    registry = configparser.ConfigParser(interpolation=None)
    registry.read_string('[avd]\n' + (Path.home() / '.android/avd/WeQRemote_API36.ini').read_text())
    if registry['avd'].get('path') != avd_path:
        raise SystemExit('AVD 注册入口没有指向本项目指定的外盘目录。')
    command = [sdk / 'emulator/emulator', '-avd', 'WeQRemote_API36', '-port', '5580', '-no-window',
               '-no-audio', '-no-snapshot', '-memory', '2048', '-cores', '2', '-gpu', 'host',
               '-no-boot-anim', '-no-metrics']
os.execv(sys.executable, [sys.executable, str(guard), '--name', 'weq-android-avd-setup' if args.create else 'weq-android-emulator',
                         '--root', args.volume, '--', *map(str, command)])
