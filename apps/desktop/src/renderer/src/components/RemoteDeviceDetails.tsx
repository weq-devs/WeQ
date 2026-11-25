import { ChevronRight } from 'lucide-react';
import { eventTimeFormatter, formatRelativeTime } from '@weq/time';
import type { RemoteAccountAccessRequest } from '../../../shared/remote_account_switch';
import { NumericText } from './NumericText';
import { TimeLabel } from './TimeLabel';

export function RemoteDeviceTime({ value, now }: { value: number | null; now?: number }) {
  if (value === null || !Number.isFinite(value) || Math.abs(value) > 8.64e15)
    return <span>暂无记录</span>;
  const text =
    now === undefined ? eventTimeFormatter.format(value) : formatRelativeTime(value, now, 1);
  return (
    <TimeLabel value={value} precision="millisecond">
      {text}
    </TimeLabel>
  );
}

export function RemoteDeviceDetails({ device }: { device: RemoteAccountAccessRequest['device'] }) {
  const { deviceInfo, lastConnection } = device;
  return (
    <details className="weq-remote-device-details">
      <summary>
        <ChevronRight size={14} aria-hidden />
        设备详情
      </summary>
      <dl>
        <div>
          <dt>设备型号</dt>
          <dd>{deviceInfo?.model ?? '未上报'}</dd>
        </div>
        <div>
          <dt>系统版本</dt>
          <dd>
            {deviceInfo ? (
              <NumericText>{`${deviceInfo.platform === 'ios' ? 'iOS / iPadOS' : 'Android'} ${deviceInfo.osVersion}`}</NumericText>
            ) : (
              '未上报'
            )}
          </dd>
        </div>
        <div>
          <dt>Remote 版本</dt>
          <dd>
            {deviceInfo ? (
              <NumericText>{`${deviceInfo.appVersion} (${deviceInfo.appBuild})`}</NumericText>
            ) : (
              '未上报'
            )}
          </dd>
        </div>
        <div>
          <dt>最近连接 IP</dt>
          <dd>{lastConnection?.ip ?? '暂无记录'}</dd>
        </div>
        <div>
          <dt>连接方式</dt>
          <dd>
            {lastConnection
              ? { lan: '局域网', tailscale: 'Tailscale', unknown: '未知网络' }[lastConnection.route]
              : '暂无记录'}
          </dd>
        </div>
        <div>
          <dt>最近访问</dt>
          <dd>
            <RemoteDeviceTime value={device.lastSeenAt} />
          </dd>
        </div>
        <div>
          <dt>设备标识</dt>
          <dd>{device.id}</dd>
        </div>
      </dl>
    </details>
  );
}
