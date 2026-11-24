import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "./ios/controls";
import { ISort, ISortAsc, ISortDesc } from "./icons";
import { tr } from "../i18n";
import { videoSortLabel, VIDEO_SORT_METRICS, type VideoSortDirection, type VideoSortMetric } from "../model/videoSort";

const DEFAULT_SORT: VideoSortMetric = "default";

/** Compact sort entry that expands from an icon into a labeled capsule. */
export function VideoSortMenu({ value, direction, onChange, className = "" }: {
  value: VideoSortMetric;
  direction: VideoSortDirection;
  onChange: (value: VideoSortMetric, direction: VideoSortDirection) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const active = value !== DEFAULT_SORT;
  const label = videoSortLabel(value, tr);
  const DirectionIcon = direction === "asc" ? ISortAsc : ISortDesc;

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) buttonRef.current?.focus();
  }, []);

  const apply = useCallback((next: VideoSortMetric) => {
    onChange(next, "desc");
    close(true);
  }, [close, onChange]);

  const selectMetric = (metric: VideoSortMetric) => {
    if (metric === value) {
      onChange(metric, direction === "desc" ? "asc" : "desc");
      return;
    }
    onChange(metric, "desc");
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]');
    if (!items?.length) return;
    const index = value === DEFAULT_SORT ? 0 : VIDEO_SORT_METRICS.findIndex(metric => metric === value) + 1;
    items[Math.min(Math.max(index, 0), items.length - 1)]?.focus();
  }, [open, value]);

  const onTriggerClick = () => {
    setOpen(current => !current);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const last = items.length - 1;
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? last
          : event.key === "ArrowDown" ? Math.min(last, currentIndex + 1)
            : Math.max(0, currentIndex - 1);
      items[nextIndex]?.focus();
    }
  };

  return (
    <div ref={wrapRef} className={`ios-sort-control ${className}`.trim()}>
      <Button ref={buttonRef}
        aria-label={active ? tr("排序：{0}", label) : tr("排序")}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        data-video-sort-trigger
        data-sort-direction={active ? direction : undefined}
        onClick={onTriggerClick} onKeyDown={onTriggerKeyDown}
        className={`ios-filter-pill ios-sort-pill ${active ? "is-labeled is-active" : "is-icon"}`}>
        {active && <span className="ios-filter-active-label">{label}</span>}
        {active
          ? <DirectionIcon size={15} strokeWidth={1.9} />
          : <ISort size={16} strokeWidth={1.9} />}
      </Button>
      {open && (
        <div ref={menuRef} id={menuId} role="menu" aria-label={tr("排序方式")} className="ios-sort-menu"
          onKeyDown={onMenuKeyDown}>
          <span className="ios-sort-menu-title">{tr("排序方式")}</span>
          <button type="button" role="menuitemradio" aria-checked={value === DEFAULT_SORT}
            onClick={() => apply(DEFAULT_SORT)}>
            <span>{tr("默认排序")}</span>
          </button>
          {VIDEO_SORT_METRICS.map(metric => {
            const itemDirection = value === metric ? direction : "desc";
            return (
              <button key={metric} type="button" role="menuitemradio" aria-checked={value === metric}
                data-sort-direction={itemDirection}
                onClick={() => selectMetric(metric)}>
                <span>{videoSortLabel(metric, tr)}</span>
                <span className="ios-sort-dir" aria-hidden="true">
                  {itemDirection === "asc" ? <ISortAsc size={14} strokeWidth={1.9} /> : <ISortDesc size={14} strokeWidth={1.9} />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
