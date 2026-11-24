import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { IClose } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";

const HOLD_MS = 480;
const MOVE_SLOP = 8;

type SearchHistoryProps = {
  items: string[];
  onPick: (term: string) => void;
  onRemove: (term: string) => void;
  onClear: () => void;
  className?: string;
};

export function SearchHistory({ items, onPick, onRemove, onClear, className = "" }: SearchHistoryProps) {
  const [editing, setEditing] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const holdTimer = useRef<number | null>(null);
  const holdOrigin = useRef<{ x: number; y: number } | null>(null);
  const holdFired = useRef(false);

  const cancelHold = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdOrigin.current = null;
  }, []);

  useEffect(() => () => cancelHold(), [cancelHold]);

  useEffect(() => {
    if (!editing) return;
    const dismiss = (event: PointerEvent) => {
      if (!sectionRef.current?.contains(event.target as Node)) setEditing(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [editing]);

  const clearAll = () => {
    onClear();
    setEditing(false);
  };

  const removeTerm = (term: string) => {
    onRemove(term);
  };

  const startHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    cancelHold();
    holdOrigin.current = { x: event.clientX, y: event.clientY };
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      holdFired.current = true;
      setEditing(true);
    }, HOLD_MS);
  };

  const moveHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = holdOrigin.current;
    if (!origin) return;
    if (Math.abs(event.clientX - origin.x) > MOVE_SLOP || Math.abs(event.clientY - origin.y) > MOVE_SLOP) {
      cancelHold();
    }
  };

  const finishHold = () => {
    cancelHold();
  };

  const clearHold = () => {
    holdFired.current = false;
    cancelHold();
  };

  const clickTerm = (term: string) => {
    if (holdFired.current) {
      holdFired.current = false;
      return;
    }
    if (editing) removeTerm(term);
    else onPick(term);
  };

  return (
    <section ref={sectionRef} role="region" aria-label={tr("搜索历史")} className={className}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-on/90">{tr("搜索历史")}</h2>
        {editing ? (
          <div className="ios-history-actions">
            <Button onClick={clearAll} className="ios-history-action">{tr("清空")}</Button>
            <span aria-hidden="true" className="ios-history-separator">|</span>
            <Button onClick={() => setEditing(false)} className="ios-history-action ios-history-done">{tr("完成")}</Button>
          </div>
        ) : (
          <Button onClick={clearAll} className="ios-history-action -mr-2">{tr("清空")}</Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 mt-2.5">
        {items.map((term) => (
          <Button
            key={term}
            aria-label={editing ? tr("删除搜索历史 {0}", term) : undefined}
            onClick={() => clickTerm(term)}
            onPointerDown={editing ? clearHold : startHold}
            onPointerMove={editing ? undefined : moveHold}
            onPointerUp={finishHold}
            onPointerCancel={finishHold}
            onPointerLeave={cancelHold}
            onContextMenu={(event) => { event.preventDefault(); setEditing(true); }}
            aria-description={editing ? undefined : tr("长按可删除")}
            title={editing ? tr("点击删除") : tr("长按可删除")}
            className="ios-filter-pill relative text-on/90"
          >
            {term}
            {editing && <span aria-hidden="true" className="ios-history-chip-remove"><IClose size={11} /></span>}
          </Button>
        ))}
      </div>
    </section>
  );
}
