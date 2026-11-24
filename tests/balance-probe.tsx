import { setBalanceVolume, getBalanceVolumeMetrics } from "../src/features/playback/balanceVolume";

const audio = document.querySelector<HTMLVideoElement>("#a")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
let started = false;

async function seek(seconds: number) {
  const done = new Promise<void>(resolve => audio.addEventListener("seeked", () => resolve(), { once: true }));
  audio.currentTime = seconds;
  await done;
}

startButton.addEventListener("click", async () => {
  setBalanceVolume(audio, true);
  await audio.play();
  started = true;
});

(window as unknown as { __balanceProbe: unknown }).__balanceProbe = {
  load: (src: string) => { audio.src = src; audio.load(); },
  isStarted: () => started,
  seek,
  metrics: () => getBalanceVolumeMetrics(audio),
  setVolume: (volume: number) => { audio.volume = volume; },
  checkOpaqueGuard: (crossOriginSrc: string) => {
    const crossOriginVideo = document.createElement("video");
    crossOriginVideo.preload = "none";
    crossOriginVideo.src = crossOriginSrc;
    setBalanceVolume(crossOriginVideo, true);
    return crossOriginVideo.dataset.balanceVolume;
  },
};
