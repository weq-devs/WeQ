import { createContext, useContext, type ButtonHTMLAttributes } from 'react';

export const MessageMenuContext = createContext(false);

/** 菜单中的禁用项仍能获得焦点，以便读取不可用原因。其他界面保留原生按钮行为。 */
export function MessageMenuButton({
  disabled,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const menu = useContext(MessageMenuContext);
  return (
    <button
      type="button"
      {...props}
      role={menu ? (props.role ?? 'menuitem') : props.role}
      tabIndex={menu ? -1 : props.tabIndex}
      disabled={!menu && disabled}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}
