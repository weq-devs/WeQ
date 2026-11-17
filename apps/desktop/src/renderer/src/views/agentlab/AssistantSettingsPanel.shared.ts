import '../../styles/assistant-settings.css';

export const ASSISTANT_SEND_MODES = [
  { value: 'interrupt', label: '立即补充' },
  { value: 'boundary', label: '下一步补充' },
  { value: 'queue', label: '排队发送' },
] as const;
