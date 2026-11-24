import { useEffect, useRef, type RefObject } from "react";
import { platform } from "../../shared/api/api";
import "../../styles/ambient-glow.css";

// Android WebView skips the full-screen 44px CSS blur pass and relies on GPU bilinear
// upscaling of an 8x5 sample grid at 4 Hz to avoid Skia tile corruption over <video> (#240).
const ANDROID_GLOW = platform === "android";
const SAMPLE_WIDTH = ANDROID_GLOW ? 8 : 32;
const SAMPLE_HEIGHT = ANDROID_GLOW ? 5 : 18;
const SAMPLE_INTERVAL_MS = ANDROID_GLOW ? 250 : 90;

type VideoFrameCallback = (now: number, metadata: unknown) => void;
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** A low-resolution color wash sampled from the playing video. */
export default function AmbientGlow({ videoRef, active }: {
  videoRef: RefObject<HTMLVideoElement | null>;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return;
    const video = videoRef.current as FrameVideo | null;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    let disposed = false;
    let frameHandle = 0;
    let fallbackTimer = 0;
    let lastDraw = 0;
    let rendered = 0;

    const draw = (force = false) => {
      if (disposed || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      const now = performance.now();
      if (!force && now - lastDraw < SAMPLE_INTERVAL_MS) return;
      lastDraw = now;
      try {
        context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
        rendered += 1;
        canvas.dataset.frames = String(rendered);
      } catch {
        // A tainted source cannot be sampled; keep the player usable without the glow.
        disposed = true;
      }
    };

    const schedule = () => {
      if (disposed) return;
      if (video.requestVideoFrameCallback) {
        frameHandle = video.requestVideoFrameCallback(() => {
          draw();
          schedule();
        });
        return;
      }
      fallbackTimer = window.setInterval(() => draw(), SAMPLE_INTERVAL_MS);
    };

    const drawNow = () => draw(true);
    video.addEventListener("loadeddata", drawNow);
    video.addEventListener("playing", drawNow);
    video.addEventListener("seeked", drawNow);
    draw(true);
    schedule();

    return () => {
      disposed = true;
      if (frameHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      if (fallbackTimer) window.clearInterval(fallbackTimer);
      video.removeEventListener("loadeddata", drawNow);
      video.removeEventListener("playing", drawNow);
      video.removeEventListener("seeked", drawNow);
    };
  }, [active, videoRef]);

  return (
    <div className="hg-ambient-glow" data-ambient-glow="on" aria-hidden="true">
      <canvas ref={canvasRef} width={SAMPLE_WIDTH} height={SAMPLE_HEIGHT} className="hg-ambient-glow-canvas" />
    </div>
  );
}
