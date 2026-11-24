import { Button } from "../../shared/ui/ios/controls";
import { useEffect, useRef, useState } from "react";
import { registerOverlayBack } from "../../shared/lib/back";
import { ILockF } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";

/** Shared anchor for the lock and unlock affordances, including the rotated landscape stage. */
export function playbackLockRightInset(rotated = false, immersive = false) {
  return rotated ? "calc(var(--sab, 0px) + 12px)" : immersive ? "calc(var(--sar, 0px) + 12px)" : "12px";
}

/** Shield pointer input, hardware back, and playback/shell shortcuts without pausing the media. */
export default function PlaybackLock({
  active, onUnlock, onBlocked, rotated = false, immersive = false, hideUnlockUntilTapped = false,
}: {
  active: boolean; onUnlock: () => void; onBlocked?: () => void; rotated?: boolean; immersive?: boolean;
  /** Mobile clean mode: keep the shield invisible until the first tap reveals the unlock affordance. */
  hideUnlockUntilTapped?: boolean;
}) {
  const [nudge, setNudge] = useState(false);
  const nudgeTimer = useRef(0);
  const pulse = (notify = false) => {
    setNudge(true);
    if (notify) onBlocked?.();
    window.clearTimeout(nudgeTimer.current);
    // Match the screen-lock toast lifetime so the unlock affordance disappears with the hint.
    nudgeTimer.current = window.setTimeout(() => setNudge(false), hideUnlockUntilTapped ? 2200 : 1200);
  };

  useEffect(() => {
    if (!active) return;
    const removeBack = registerOverlayBack(() => { pulse(); return true; });
    const block = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [data-playback-unlock], [role='dialog']")) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if ([
        " ", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
        "Home", "End", "PageUp", "PageDown", "/", "1", "2", "3", "4",
        "f", "t", "m", "l", "s", "c", "e",
      ].includes(key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        pulse();
      }
    };
    window.addEventListener("keydown", block, true);
    return () => {
      window.clearTimeout(nudgeTimer.current);
      removeBack();
      window.removeEventListener("keydown", block, true);
    };
  }, [active]);

  const rightInset = playbackLockRightInset(rotated, immersive);

  return <div data-playback-lock-shield className="absolute inset-0 z-50" style={{ touchAction: "none" }}
    onPointerDown={e => { e.stopPropagation(); pulse(true); }} onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    {(!hideUnlockUntilTapped || nudge) && (
      <Button type="button" data-playback-unlock aria-label={tr("解锁屏幕")} title={tr("解锁屏幕")} aria-pressed
        style={{ right: rightInset }}
        onPointerDown={e => e.stopPropagation()}
        onClick={onUnlock} className={`playback-unlock absolute top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center ${nudge ? "is-nudged" : ""}`}>
        <ILockF size={19} />
      </Button>
    )}
  </div>;
}
