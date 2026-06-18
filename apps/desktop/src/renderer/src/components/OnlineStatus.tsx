import { trpc } from '../trpc/client';
import { Circle, Smile, Clock, Minus, Ban, MinusCircle } from 'lucide-react';

const SUB_ICONS: Record<number, string> = {
  1028: 'music@2x.png',
  1030: 'weather_3x.png',
  2003: 'chuqulang2.png',
  2015: 'gototravel.png',
  2014: 'tkong.png',
  1051: 'relationship_3x.png',
  1071: 'jinli@2x.png',
  1201: 'luck@2x.png',
  1056: 'happytofly@3x.png',
  1058: 'fullofyuanqi@3x.png',
  1063: 'hardtosay@3x.png',
  2001: 'nandehutu.png',
  1401: 'emonew@2x.png',
  1062: 'toohard@3x.png',
  2013: 'woxiangkaile.png',
  1052: 'imfine_3x.png',
  1061: 'bequiet@3x.png',
  1059: 'youzaizai@3x.png',
  1011: 'signal_3x.png',
  1016: 'sleeping_3x.png',
  2012: 'ganzuoye.png',
  1018: 'study_3x.png',
  2023: 'banzhuan.png',
  1300: 'fish@2x.png',
  1060: 'boring@3x.png',
  1027: 'timi_3x.png',
  2025: 'yiqiyuanmeng.png',
  2026: 'qiuxingdazi.png',
  1032: 'stayup_3x.png',
  1021: 'tv_3x.png',
  2019: 'crush.png',
  2006: 'aiziji@2x.png',
};

const TYPE_ICONS = {
  10: () => <Circle size={10} fill="#52c41a" stroke="#52c41a" />,
  60: () => <Smile size={12} stroke="#faad14" />,
  30: () => <Clock size={12} stroke="#8c8c8c" />,
  50: () => <Minus size={12} stroke="#faad14" />,
  70: () => <Ban size={12} stroke="#ff4d4f" />,
  40: () => <MinusCircle size={12} stroke="#8c8c8c" />,
};

export function OnlineStatus({ uid }: { uid: string }) {
  const { data: status } = trpc.account.getOnlineStatus.useQuery({ uid });

  if (!status || status.typeName === '未知') return null;

  const filename = status.type === 10 && SUB_ICONS[status.subType];
  const icon = filename
    ? <img src={`weq-asset://OnlineStatus/${filename}`} alt="" style={{ width: 16, height: 16 }} />
    : TYPE_ICONS[status.type]?.();

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#8c8c8c' }}>
      {icon}
      <span>{status.displayStatus}</span>
    </span>
  );
}
