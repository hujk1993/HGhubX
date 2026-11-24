import Hls from "hls.js";

/**
 * App-level loudness leveling for HTML video playback.
 *
 * Video sources can differ by 20 dB or more. The graph measures the source level
 * before processing, applies a slow RMS gain toward a fixed target, and uses a
 * limiter to keep peaks from clipping. The element's volume and mute state stay
 * authoritative: the gain target is compensated by the element volume, so
 * lowering the user volume still lowers the output.
 *
 * Safety boundary: MediaElementAudioSourceNode permanently routes a <video>'s
 * audio into Web Audio and outputs silence if the media element is CORS-opaque
 * (or on iOS native AVPlayer HLS). Only attach when the loaded source is a
 * readable blob:/data:/same-origin/CORS stream.
 */

type Chain = {
  ctx: AudioContext;
  video: HTMLVideoElement;
  source: MediaElementAudioSourceNode;
  agc: GainNode;
  limiter: DynamicsCompressorNode;
  inputAnalyser: AnalyserNode;
  outputAnalyser: AnalyserNode;
  dry: GainNode;
  wet: GainNode;
  inputBuffer: Float32Array<ArrayBuffer>;
  outputBuffer: Float32Array<ArrayBuffer>;
  timer: number;
  resetTimer: number;
  enabled: boolean;
  initialized: boolean;
  levelDb: number | null;
  lastGainDb: number;
  inputDb: number | null;
  outputDb: number | null;
  outputPeakDb: number | null;
  desiredDb: number;
};

export type BalanceVolumeMetrics = {
  state: "off" | "pending" | "on" | "unsupported";
  inputDb: number | null;
  outputDb: number | null;
  outputPeakDb: number | null;
  levelDb: number | null;
  desiredDb: number;
  gainDb: number;
  reductionDb: number;
};

const TARGET_RMS_DB = -19;
const GATE_DB = -55;
const MAX_BOOST_DB = 28;
const MAX_CUT_DB = -18;
const DEADBAND_DB = 0.5;
const LEVEL_RISE_ALPHA = 0.12;
const LEVEL_FALL_ALPHA = 0.06;
const AGC_INTERVAL_MS = 50;
const ATTACK_SECONDS = 0.4;
const RELEASE_SECONDS = 1.2;
const CROSSFADE_SECONDS = 0.2;
const LIMITER_CEIL_DB = -1.5;
const PEAK_MARGIN_DB = 1;

const chains = new WeakMap<HTMLVideoElement, Chain>();
const wanted = new WeakMap<HTMLVideoElement, boolean>();
const pending = new WeakMap<HTMLVideoElement, () => void>();
const pendingSource = new WeakMap<HTMLVideoElement, () => void>();
const attachedRefs: WeakRef<HTMLVideoElement>[] = [];
let sharedContext: AudioContext | null = null;
let suspendTimer = 0;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    ?? null;
}

/** True when the runtime supports MSE + Web Audio leveling (hides toggle on iOS native AVPlayer). */
export function isBalanceVolumeSupported(): boolean {
  return Boolean(audioContextCtor()) && Hls.isSupported();
}

function createContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try { return new Ctor({ latencyHint: "interactive" }); }
  catch {
    try { return new Ctor(); }
    catch { return null; }
  }
}

function getContext(): AudioContext | null {
  if (sharedContext?.state === "closed") sharedContext = null;
  if (!sharedContext) sharedContext = createContext();
  return sharedContext;
}

function setState(video: HTMLVideoElement, state: BalanceVolumeMetrics["state"]) {
  video.dataset.balanceVolume = state;
}

function canSampleElementAudio(video: HTMLVideoElement): "ready" | "empty" | "opaque" {
  const current = video.currentSrc || video.src;
  if (!current) return "empty";
  if (current.startsWith("blob:") || current.startsWith("data:")) return "ready";
  try {
    const url = new URL(current, location.href);
    return url.origin === location.origin || Boolean(video.crossOrigin) ? "ready" : "opaque";
  } catch {
    return "opaque";
  }
}

function anyAttachedVideoPlaying(): boolean {
  for (let i = attachedRefs.length - 1; i >= 0; i -= 1) {
    const el = attachedRefs[i].deref();
    if (!el) {
      attachedRefs.splice(i, 1);
      continue;
    }
    if (el.isConnected && !el.paused && !el.ended) return true;
  }
  return false;
}

function scheduleContextIdleCheck(ctx: AudioContext) {
  if (suspendTimer) window.clearTimeout(suspendTimer);
  suspendTimer = window.setTimeout(() => {
    suspendTimer = 0;
    if (ctx.state === "running" && !anyAttachedVideoPlaying()) {
      void ctx.suspend().catch(() => {});
    }
  }, 320);
}

function ramp(param: AudioParam, value: number, ctx: AudioContext) {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + CROSSFADE_SECONDS);
}

function stopTimer(chain: Chain) {
  if (chain.timer) {
    window.clearInterval(chain.timer);
    chain.timer = 0;
  }
}

function levelsFromBuffer(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i];
    sum += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return {
    rmsDb: 20 * Math.log10(Math.sqrt(sum / buffer.length) + 1e-7),
    peakDb: 20 * Math.log10(peak + 1e-7),
  };
}

function resetAnalysis(chain: Chain) {
  chain.initialized = false;
  chain.levelDb = null;
  chain.lastGainDb = 0;
}

function tick(chain: Chain) {
  if (!chain.enabled || chain.ctx.state !== "running" || chain.video.paused || chain.video.seeking) return;
  if (chain.video.muted || chain.video.volume <= 0) return;

  const volumeDb = 20 * Math.log10(chain.video.volume);
  const input = levelsFromBuffer(chain.inputAnalyser, chain.inputBuffer);
  /* Remove the element-volume gain before comparing sources. The target then stays
     relative to the user's volume instead of boosting quiet playback back up. */
  const contentDb = input.rmsDb - volumeDb;
  const contentPeakDb = input.peakDb - volumeDb;
  if (contentDb < GATE_DB) {
    chain.inputDb = null;
    return;
  }

  if (chain.levelDb === null) chain.levelDb = contentDb;
  else {
    const alpha = contentDb > chain.levelDb ? LEVEL_RISE_ALPHA : LEVEL_FALL_ALPHA;
    chain.levelDb += alpha * (contentDb - chain.levelDb);
  }

  /* Keep boosted peaks below the limiter ceiling so quiet, high-crest sources
     do not turn into clipped distortion. */
  const peakCapDb = LIMITER_CEIL_DB - PEAK_MARGIN_DB - contentPeakDb;
  const desiredGainDb = Math.max(
    MAX_CUT_DB,
    Math.min(MAX_BOOST_DB, TARGET_RMS_DB - chain.levelDb, peakCapDb),
  );
  chain.desiredDb = desiredGainDb;
  const now = chain.ctx.currentTime;
  if (!chain.initialized) {
    chain.agc.gain.cancelScheduledValues(now);
    chain.agc.gain.setValueAtTime(10 ** (desiredGainDb / 20), now);
    chain.lastGainDb = desiredGainDb;
    chain.initialized = true;
  } else if (Math.abs(desiredGainDb - chain.lastGainDb) >= DEADBAND_DB) {
    const attack = desiredGainDb < chain.lastGainDb;
    chain.agc.gain.cancelScheduledValues(now);
    chain.agc.gain.setTargetAtTime(
      10 ** (desiredGainDb / 20),
      now,
      attack ? ATTACK_SECONDS : RELEASE_SECONDS,
    );
    chain.lastGainDb = desiredGainDb;
  }

  chain.inputDb = contentDb;
  const output = levelsFromBuffer(chain.outputAnalyser, chain.outputBuffer);
  chain.outputDb = output.rmsDb;
  chain.outputPeakDb = output.peakDb;
}

function startTimer(chain: Chain) {
  if (chain.timer) return;
  chain.timer = window.setInterval(() => tick(chain), AGC_INTERVAL_MS);
}

function enableChain(chain: Chain) {
  chain.enabled = true;
  if (suspendTimer) {
    window.clearTimeout(suspendTimer);
    suspendTimer = 0;
  }
  if (chain.resetTimer) {
    window.clearTimeout(chain.resetTimer);
    chain.resetTimer = 0;
  }
  resetAnalysis(chain);
  if (!chain.video.paused) startTimer(chain);
  ramp(chain.dry.gain, 0, chain.ctx);
  ramp(chain.wet.gain, 1, chain.ctx);
  setState(chain.video, "on");
  void chain.ctx.resume().catch(() => {});
}

function disableChain(chain: Chain) {
  chain.enabled = false;
  ramp(chain.dry.gain, 1, chain.ctx);
  ramp(chain.wet.gain, 0, chain.ctx);
  setState(chain.video, "off");
  stopTimer(chain);
  if (chain.resetTimer) window.clearTimeout(chain.resetTimer);
  chain.resetTimer = window.setTimeout(() => {
    chain.resetTimer = 0;
    const now = chain.ctx.currentTime;
    chain.agc.gain.cancelScheduledValues(now);
    chain.agc.gain.setValueAtTime(1, now);
    resetAnalysis(chain);
    scheduleContextIdleCheck(chain.ctx);
  }, 300);
}

function clearPending(video: HTMLVideoElement) {
  const cleanup = pending.get(video);
  if (cleanup) {
    cleanup();
    pending.delete(video);
  }
  const sourceCleanup = pendingSource.get(video);
  if (sourceCleanup) {
    sourceCleanup();
    pendingSource.delete(video);
  }
}

function waitForReadableSource(video: HTMLVideoElement, ctx: AudioContext) {
  if (pendingSource.has(video)) return;
  const onSource = () => {
    cleanup();
    if (wanted.get(video)) attach(video, ctx);
  };
  const cleanup = () => {
    video.removeEventListener("loadedmetadata", onSource);
    video.removeEventListener("play", onSource);
    pendingSource.delete(video);
  };
  video.addEventListener("loadedmetadata", onSource, { once: true });
  video.addEventListener("play", onSource, { once: true });
  pendingSource.set(video, cleanup);
}

function waitForGesture(video: HTMLVideoElement, ctx: AudioContext) {
  if (pending.has(video)) return;
  let done = false;
  const events = ["pointerdown", "keydown", "touchend"] as const;
  const cleanup = () => {
    for (const event of events) document.removeEventListener(event, unlock, true);
  };
  const unlock = () => {
    if (done) return;
    done = true;
    cleanup();
    pending.delete(video);
    void ctx.resume().then(() => {
      if (wanted.get(video)) attach(video, ctx);
    }).catch(() => { /* Leave the dry path active; the setting stays pending. */ });
  };
  for (const event of events) document.addEventListener(event, unlock, true);
  pending.set(video, cleanup);
}

function attach(video: HTMLVideoElement, ctx: AudioContext) {
  if (!wanted.get(video)) return;
  const existing = chains.get(video);
  if (existing) { enableChain(existing); return; }

  const eligibility = canSampleElementAudio(video);
  if (eligibility === "empty") {
    waitForReadableSource(video, ctx);
    return;
  }
  if (eligibility === "opaque") {
    clearPending(video);
    setState(video, "unsupported");
    return;
  }
  clearPending(video);

  try {
    const source = ctx.createMediaElementSource(video);

    /* Measure the source before applying gain so the level target is stable. */
    const inputAnalyser = ctx.createAnalyser();
    inputAnalyser.fftSize = 2048;
    inputAnalyser.smoothingTimeConstant = 0;
    source.connect(inputAnalyser);

    const agc = ctx.createGain();
    agc.gain.value = 1;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0;
    limiter.release.value = 0.15;

    const outputAnalyser = ctx.createAnalyser();
    outputAnalyser.fftSize = 2048;
    outputAnalyser.smoothingTimeConstant = 0;

    const dry = ctx.createGain();
    dry.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0;

    source.connect(dry);
    dry.connect(ctx.destination);
    source.connect(agc);
    agc.connect(limiter);
    limiter.connect(outputAnalyser);
    outputAnalyser.connect(wet);
    wet.connect(ctx.destination);

    const chain: Chain = {
      ctx, video, source, agc, limiter, inputAnalyser, outputAnalyser, dry, wet,
      inputBuffer: new Float32Array(inputAnalyser.fftSize),
      outputBuffer: new Float32Array(outputAnalyser.fftSize),
      timer: 0, resetTimer: 0, enabled: false, initialized: false,
      levelDb: null, lastGainDb: 0, inputDb: null, outputDb: null, outputPeakDb: null, desiredDb: 0,
    };
    chains.set(video, chain);
    attachedRefs.push(new WeakRef(video));
    video.addEventListener("play", () => {
      if (suspendTimer) {
        window.clearTimeout(suspendTimer);
        suspendTimer = 0;
      }
      void ctx.resume().catch(() => {});
      if (chain.enabled) startTimer(chain);
    });
    const onStop = () => {
      stopTimer(chain);
      scheduleContextIdleCheck(ctx);
    };
    video.addEventListener("pause", onStop);
    video.addEventListener("ended", onStop);
    video.addEventListener("loadstart", () => resetAnalysis(chain));
    enableChain(chain);
  } catch {
    setState(video, "unsupported");
  }
}

/** Apply the persisted preference to a video element. Creating the source node is lazy. */
export function setBalanceVolume(video: HTMLVideoElement | null, enabled: boolean) {
  if (!video) return;
  wanted.set(video, enabled);
  if (!enabled) {
    clearPending(video);
    const chain = chains.get(video);
    if (chain) disableChain(chain);
    else setState(video, "off");
    return;
  }

  const eligibility = canSampleElementAudio(video);
  if (eligibility === "opaque") {
    clearPending(video);
    setState(video, "unsupported");
    return;
  }

  const ctx = getContext();
  if (!ctx) { setState(video, "unsupported"); return; }
  setState(video, "pending");
  const activate = () => {
    if (wanted.get(video) && ctx.state === "running") attach(video, ctx);
  };
  void ctx.resume().then(activate).catch(() => { /* Wait for the next explicit gesture. */ });
  if (ctx.state !== "running") waitForGesture(video, ctx);
  else activate();
}

/** Test-only observability for the live audio graph. */
export function getBalanceVolumeMetrics(video: HTMLVideoElement | null): BalanceVolumeMetrics | null {
  if (!video) return null;
  const chain = chains.get(video);
  if (!chain) {
    return {
      state: (video.dataset.balanceVolume as BalanceVolumeMetrics["state"]) ?? "off",
      inputDb: null, outputDb: null, outputPeakDb: null, levelDb: null, desiredDb: 0, gainDb: 0,
      reductionDb: 0,
    };
  }
  return {
    state: (video.dataset.balanceVolume as BalanceVolumeMetrics["state"]) ?? "off",
    inputDb: chain.inputDb,
    outputDb: chain.outputDb,
    outputPeakDb: chain.outputPeakDb,
    levelDb: chain.levelDb,
    desiredDb: chain.desiredDb,
    gainDb: 20 * Math.log10(chain.agc.gain.value + 1e-7),
    reductionDb: chain.limiter.reduction,
  };
}
