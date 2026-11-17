import { eventTimeFormatter } from '@weq/time';
import '../styles/avatar-history.css';

const formatter = eventTimeFormatter;
export const avatarHistoryTime = (value: number | null) =>
  value === null ? '时间未记录' : formatter.format(value * 1000);
