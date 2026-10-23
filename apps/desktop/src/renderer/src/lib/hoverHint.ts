/** 单按修饰键不会改变当前交互，悬浮提示应保持；组合键仍按实际按键关闭。 */
export function shouldDismissHoverHint(event: Pick<KeyboardEvent, 'key'>): boolean {
  return !['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(event.key);
}
