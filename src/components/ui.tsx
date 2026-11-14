import { Button, Image, Surface } from "./ios/controls";
import React, { useEffect, useRef, useState } from "react";
import { cover, platform } from "../api";
export { Sheet, Modal, DockPanel } from "./ios/overlays";
import { useStore } from "../store";
import { IBoltF, ICheck, IClose, IGlobe, IHeartF, IMinus, ISparkF, IStarF } from "../icons";

/* ——— 头像 ——— */
export function Avatar({ hue = 250, icon, name, size = 40, ring = false, className = "" }: {
  hue?: number; icon?: React.ReactNode; name?: string; size?: number; ring?: boolean; className?: string;
}) {
  const inner = (
    <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden font-semibold"
      style={{ background: `hsl(${hue} 22% 30%)`, color: `hsl(${hue} 70% 88%)` }}>
      {icon ?? <span style={{ fontSize: size * 0.42 }} className="leading-none">{(name || "H").replace(/^@/, "")[0].toUpperCase()}</span>}
    </div>
  );
  return (
    <div className={`shrink-0 ${className}`} style={{ width: size, height: size }}>
      {ring ? <div className="w-full h-full rounded-full p-[2px] bg-primary"><div className="w-full h-full rounded-full bg-bg p-[2px]">{inner}</div></div> : inner}
    </div>
  );
}

/* ——— 开关 ——— */
export function Toggle({ on, onChange, label, disabled = false }: { on: boolean; onChange: (b: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <Button disabled={disabled} onClick={() => onChange(!on)} role="switch" aria-checked={on} aria-label={label}
      className="ios-switch" data-platform={platform} data-state={on ? "on" : "off"}>
      <span className="ios-switch-track" aria-hidden="true">
        <span className="ios-switch-thumb">
          <ICheck size={14} className="ios-switch-mark is-on" />
          <IMinus size={14} className="ios-switch-mark is-off" />
        </span>
      </span>
    </Button>
  );
}

/* ——— 空状态 ——— */
export function Empty({ icon, title, sub, action, onAction }: {
  icon: React.ReactNode; title: string; sub?: string; action?: string; onAction?: () => void;
}) {
  return (
    <div className="ios-empty flex flex-col items-center justify-center py-16 px-8 text-center a-rise">
      <div className="w-16 h-16 rounded-(--r-md) tonal flex items-center justify-center mb-4">{icon}</div>
      <div className="text-[16px] font-semibold text-on/90">{title}</div>
      {sub && <div className="text-xs text-mut mt-1.5 leading-relaxed">{sub}</div>}
      {action && (
        <Button onClick={onAction} className="mt-5 px-6 h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[14px] font-bold pressable">{action}</Button>
      )}
    </div>
  );
}

/* ——— 键帽 ——— */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-(--r-ctl) bg-s4 text-[12px] font-semibold text-on/85 elev-1">{children}</span>;
}

/* ——— Toast ——— */
export function ToastHost() {
  const { toasts } = useStore();
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="ios-toast-host absolute inset-x-0 z-[80] flex flex-col items-center gap-2 pointer-events-none px-6" style={{ bottom: "calc(var(--sab, 0px) + 96px)" }}>
      {toasts.map((t) =>
        t.line ? (
          <div
            key={t.id}
            className="a-toast pointer-events-auto relative flex items-center gap-2.5 max-w-full bg-s4/80 backdrop-blur-2xl rounded-[16px] pl-2 pr-3 py-2 elev-3 ring-1 ring-white/10"
          >
            <span
              className={`grid place-items-center size-9 rounded-[12px] shrink-0 ${
                t.line.region === "cn"
                  ? "bg-mint/15 text-mint"
                  : "bg-cyan/15 text-cyan"
              }`}
            >
              {t.line.region === "cn" ? <IBoltF size={17} /> : <IGlobe size={17} />}
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-on leading-tight">
                {t.line.region === "cn" ? "国内线路" : "国外线路"}
              </div>
              <div className="text-[12px] text-dim leading-tight mt-0.5 truncate">{t.line.host}</div>
            </div>
            <div className="ml-1.5 flex items-baseline gap-0.5 shrink-0 pl-2.5 border-l border-white/10">
              <span
                className={`text-[16px] font-bold tabular-nums ${
                  t.line.ms <= 0
                    ? "text-dim"
                    : t.line.ms < 500
                      ? "text-mint"
                      : t.line.ms < 1000
                        ? "text-amber"
                        : "text-danger"
                }`}
              >
                {t.line.ms > 0 ? t.line.ms : "—"}
              </span>
              {t.line.ms > 0 && <span className="text-[12px] font-semibold text-dim">ms</span>}
            </div>
          </div>
        ) : (
          <Surface key={t.id} className="a-toast pointer-events-auto flex items-center gap-2.5 max-w-full bg-s4/95 backdrop-blur-md rounded-(--r-sm) pl-3.5 pr-4 py-2.5 elev-3">
            {t.icon === "ok" && <ICheck size={16} className="text-mint shrink-0" />}
            {t.icon === "heart" && <IHeartF size={16} className="text-neon shrink-0" />}
            {t.icon === "star" && <IStarF size={16} className="text-amber shrink-0" />}
            {t.icon === "info" && <ISparkF size={15} className="text-cyan shrink-0" />}
            <span className="text-[14px] text-on truncate">{t.msg}</span>
          </Surface>
        ),
      )}
    </div>
  );
}

/* ——— 长按 ——— */
export function useLongPress(cb: (e: { clientX: number; clientY: number }) => void, ms = 480) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const clear = () => { window.clearTimeout(timer.current); };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      const { clientX, clientY } = e;
      timer.current = window.setTimeout(() => { fired.current = true; cb({ clientX, clientY }); }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (Math.abs(e.clientX - start.current.x) > 10 || Math.abs(e.clientY - start.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onClickCapture: (e: React.MouseEvent) => { if (fired.current) { e.stopPropagation(); e.preventDefault(); fired.current = false; } },
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); cb({ clientX: e.clientX, clientY: e.clientY }); },
  };
}

/* ——— 关闭按钮 ——— */
export function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <Button aria-label="关闭" onClick={onClick} className="ios-icon-button bg-s3/80 text-mut">
      <IClose size={16} />
    </Button>
  );
}

/* ——— 图片（骨架 + 渐显，自动走本地解密协议） ——— */
export function Img({ src, alt = "", className = "", eager = false, raw = false }: {
  src: string; alt?: string; className?: string; eager?: boolean; raw?: boolean;
}) {
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(false);
  const url = raw ? src : cover(src);
  useEffect(() => { setOk(false); setErr(false); }, [url]);
  return (
    <div className={`ios-image absolute inset-0 overflow-hidden ${className}`} data-ui="image-frame">
      {!ok && !err && <div className="absolute inset-0 shimmer" />}
      {err && <div className="ios-image-error" role="img" aria-label={alt || "封面暂不可用"}>HG</div>}
      <Image src={url} alt={alt} loading={eager ? "eager" : "lazy"} onLoad={() => setOk(true)} onError={() => setErr(true)}
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${ok ? "opacity-100" : "opacity-0"}`} draggable={false} />
    </div>
  );
}
