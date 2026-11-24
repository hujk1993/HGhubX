import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const SWIPE_DISTANCE = 56;
const AXIS_RATIO = 1.35;
const CLICK_SUPPRESS_MS = 360;

type TabSwipeOptions<T extends HTMLElement> = {
  rootRef: RefObject<T | null>;
  tabIndex: number;
  tabCount: number;
  onTabChange: (index: number) => void;
  ignoreSelector?: string;
};

/**
 * Horizontal tab navigation for a scrollable page section.
 * Touch events are listened to natively because a vertical scroll cancels
 * Pointer Events; mouse and pen input still use Pointer Events.
 */
export function useTabSwipe<T extends HTMLElement>({
  rootRef,
  tabIndex,
  tabCount,
  onTabChange,
  ignoreSelector = "input, textarea, select, [role=dialog], [data-tab-swipe-ignore]",
}: TabSwipeOptions<T>) {
  const current = useRef({ tabIndex, tabCount, onTabChange, ignoreSelector });
  current.current = { tabIndex, tabCount, onTabChange, ignoreSelector };
  const pointerStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const touchStart = useRef<{ x: number; y: number; lastX: number; lastY: number } | null>(null);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | undefined>(undefined);

  const armClickSuppression = () => {
    window.clearTimeout(suppressTimer.current);
    suppressClick.current = true;
    suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; }, CLICK_SUPPRESS_MS);
  };

  const commit = (startX: number, startY: number, endX: number, endY: number) => {
    const dx = endX - startX;
    const dy = endY - startY;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) <= Math.abs(dy) * AXIS_RATIO) return;
    const next = dx < 0 ? current.current.tabIndex + 1 : current.current.tabIndex - 1;
    if (next < 0 || next >= current.current.tabCount) return;
    armClickSuppression();
    current.current.onTabChange(next);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const canStart = (target: EventTarget | null) => target instanceof Element &&
      !target.closest(current.current.ignoreSelector);

    const begin = (event: TouchEvent) => {
      if (current.current.tabCount <= 1 || event.touches.length !== 1) { touchStart.current = null; return; }
      const touch = event.touches[0];
      if (!canStart(event.target)) { touchStart.current = null; return; }
      touchStart.current = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      const gesture = touchStart.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      /* Claim a clearly horizontal gesture so the browser cannot turn it into a
         click on the card underneath. Vertical scrolling is left untouched. */
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) event.preventDefault();
    };
    const finish = (event: TouchEvent) => {
      const gesture = touchStart.current;
      touchStart.current = null;
      if (!gesture) return;
      const touch = event.changedTouches[0];
      commit(gesture.x, gesture.y, touch?.clientX ?? gesture.lastX, touch?.clientY ?? gesture.lastY);
    };

    root.addEventListener("touchstart", begin, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", finish, { passive: true });
    root.addEventListener("touchcancel", finish, { passive: true });
    return () => {
      root.removeEventListener("touchstart", begin);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", finish);
      root.removeEventListener("touchcancel", finish);
    };
  }, [rootRef]);

  useEffect(() => () => window.clearTimeout(suppressTimer.current), []);

  const onPointerDown = (event: ReactPointerEvent<T>) => {
    if (current.current.tabCount <= 1 || event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
    if (!(event.target instanceof Element) || event.target.closest(current.current.ignoreSelector)) return;
    pointerStart.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  };
  const onPointerUp = (event: ReactPointerEvent<T>) => {
    const gesture = pointerStart.current;
    pointerStart.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    commit(gesture.x, gesture.y, event.clientX, event.clientY);
  };
  const onClickCapture = (event: ReactMouseEvent<T>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel: () => { pointerStart.current = null; },
    onClickCapture,
  };
}
