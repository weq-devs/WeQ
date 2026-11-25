const PROFILE_AVATARS = '.avatar, .weq-avatar-picture, .weq-avatar-img, .weq-avatar-fallback';
export const POKE_PRESS_MS = 60;
const RELEASE_MS = 170;
const playing = new WeakMap<HTMLElement, Animation>();

export function profileAvatarAtClick(trigger: Element, target: EventTarget | null) {
  const clicked = target as Element | null;
  const avatar =
    clicked?.closest?.<HTMLElement>('.weq-avatar-pendant') ??
    clicked?.closest?.<HTMLElement>(PROFILE_AVATARS) ??
    (trigger.matches('.message-avatar-button')
      ? trigger.querySelector<HTMLElement>('.weq-avatar-pendant')
      : null);
  return avatar && trigger.contains(avatar) ? avatar : undefined;
}

export function pressProfileAvatar(avatar: HTMLElement, reducedMotion: boolean) {
  playing.get(avatar)?.cancel();

  if (reducedMotion) {
    return (confirmed: boolean) => {
      if (!confirmed || !avatar.isConnected) return;
      const outline = {
        outlineStyle: 'solid',
        outlineWidth: '2px',
        outlineOffset: '2px',
        ...(avatar.matches('.weq-avatar-pendant') ? { borderRadius: '50%' } : {}),
      };
      playFeedback(avatar, [
        {
          ...outline,
          outlineColor: 'var(--weq-accent-ink, var(--weq-accent-effective, currentColor))',
        },
        { ...outline, outlineColor: 'transparent' },
      ]);
    };
  }

  const press = avatar.animate([{ scale: '1' }, { scale: '0.94' }], {
    duration: POKE_PRESS_MS,
    easing: 'ease-out',
    fill: 'both',
  });
  playing.set(avatar, press);

  return (confirmed: boolean) => {
    if (!confirmed) {
      press.cancel();
      if (playing.get(avatar) === press) playing.delete(avatar);
      return;
    }

    // 快速点按也应完成压缩，随后从同一帧回弹。
    void press.finished.then(
      () => {
        if (playing.get(avatar) !== press) return;
        press.cancel();
        if (!avatar.isConnected) {
          playing.delete(avatar);
          return;
        }
        playFeedback(avatar, [
          { scale: '0.94', translate: '0px', easing: 'ease-out' },
          { scale: '1', translate: '-3px', offset: 0.3, easing: 'ease-in-out' },
          { scale: '1', translate: '2px', offset: 0.62, easing: 'ease-out' },
          { scale: '1', translate: '0px' },
        ]);
      },
      () => {},
    );
  };
}

function playFeedback(avatar: HTMLElement, frames: Keyframe[]) {
  const animation = avatar.animate(frames, RELEASE_MS);
  playing.set(avatar, animation);
  const forget = () => {
    if (playing.get(avatar) === animation) playing.delete(avatar);
  };
  void animation.finished.then(forget, forget);
}
