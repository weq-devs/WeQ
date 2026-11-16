import { preferenceValue, useClientPreferences } from '../../lib/clientPreferences';
import { Row } from './controls';
import { SharedDisplayToggle } from './SharedDisplayToggle';

export function SlashEmojiSettings() {
  useClientPreferences((state) => state.tick);
  return (
    <>
      <Row
        settingId="slash-emoji-input"
        label="斜杠表情快捷输入"
        control={
          <SharedDisplayToggle name="slashEmojiEnabled" label="斜杠表情快捷输入" fallback={true} />
        }
      />
      {preferenceValue('slashEmojiEnabled') ? (
        <Row
          settingId="slash-emoji-auto-replace"
          label="无需回车即自动替换"
          indent
          control={
            <SharedDisplayToggle
              name="slashEmojiAutoReplace"
              label="无需回车即自动替换"
              fallback={false}
            />
          }
        />
      ) : null}
    </>
  );
}
