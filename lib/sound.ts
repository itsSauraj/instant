/**
 * Programmatic UI sound effects, synthesized with the Web Audio API.
 *
 * Design goals, in order: never annoying, always meaningful, always safe.
 * Every cue is derived from one key (A major, just intonation) so the whole
 * app sounds like a single soft instrument. Rising motion means "on" or
 * "something good arrived"; falling motion means "off", "left" or "failed",
 * so the vocabulary is learnable without ever reading a label.
 *
 * Smoothness is engineered, not hoped for:
 *  - voices are detuned sine pairs plus a quiet octave, never square/saw;
 *  - gain only ever moves through ramps (linear attack, `setTargetAtTime`
 *    exponential release) - an instantaneous gain step is an audible click;
 *  - every voice passes a gentle lowpass whose cutoff breathes with the
 *    envelope, which removes the last of the "digital" edge;
 *  - a shared master bus (procedural convolver tail -> soft-knee compressor
 *    -> quiet master gain) guarantees overlapping cues cannot clip.
 *
 * Everything is SSR-safe: no `window`/`AudioContext` access at module scope.
 */

export type SoundCue =
  | "noteSent"
  | "noteReceived"
  | "peerJoined"
  | "peerLeft"
  | "sessionEnded"
  | "fileStarted"
  | "fileSent"
  | "fileReceived"
  | "fileFailed"
  | "micOn"
  | "micOff"
  | "cameraOn"
  | "cameraOff"
  | "screenShareOn"
  | "screenShareOff"
  | "knock"
  | "error";

export const SOUND_CUES: readonly SoundCue[] = [
  "noteSent",
  "noteReceived",
  "peerJoined",
  "peerLeft",
  "sessionEnded",
  "fileStarted",
  "fileSent",
  "fileReceived",
  "fileFailed",
  "micOn",
  "micOff",
  "cameraOn",
  "cameraOff",
  "screenShareOn",
  "screenShareOff",
  "knock",
  "error",
];

/** Mirrors `instant-theme`; absent means the default (sound on). */
const STORAGE_KEY = "instant-sound";

/** Master output level. Deliberately quiet: cues sit under the conversation. */
const MASTER_LEVEL = 0.12;

/** At most this many cues may sound at once; extras are dropped, not queued. */
const MAX_VOICES = 5;

/** Repeats of the same cue inside this window collapse into one. */
const REPEAT_WINDOW_MS = 150;

// ---------------------------------------------------------------- cue table

/**
 * One note of a cue. Each note becomes a small voice: two sines detuned a few
 * cents apart (the slow beating is what reads as "warm"), plus an octave sine
 * at very low gain for air, through a breathing lowpass and an ADSR-ish gain.
 */
type NoteSpec = {
  /** Onset, seconds after the cue starts. */
  at: number;
  /** Fundamental in Hz. Kept in a mid register; nothing shrill. */
  f: number;
  /** Portamento target: the note glides instead of jumping. */
  glideTo?: number;
  /** Glide time in seconds (defaults to 0.1). */
  glideTime?: number;
  /** Attack seconds. Never below 0.02 - a faster attack on a sine clicks. */
  attack?: number;
  /** Full-level hold before the release begins. */
  hold?: number;
  /** Release time constant for `setTargetAtTime`; audible tail is ~7x this. */
  tau?: number;
  /** Envelope peak, pre-master. */
  peak?: number;
  /** Lowpass cutoff ceiling for this note. */
  cutoff?: number;
};

// The whole app plays in A major (A4 = 440 Hz), just intonation, so every
// interval below is consonant by construction: 5:4 third, 4:3 fourth,
// 3:2 fifth, 2:1 octave.
const A3 = 220;
const CS4 = 275; // A3 * 5/4
const E4 = 330; // A3 * 3/2
const A4 = 440;
const CS5 = 550;
const D5 = 586.67;
const E5 = 660;
const A5 = 880;

const CUES: Record<SoundCue, NoteSpec[]> = {
  // A quick upward "swip": one short fifth-to-octave glide.
  noteSent: [{ at: 0, f: E5, glideTo: A5, glideTime: 0.08, hold: 0.015, tau: 0.07, peak: 0.4 }],
  // The classic two-note ding: a fourth up, second note rings a little longer.
  noteReceived: [
    { at: 0, f: E5, hold: 0.02, tau: 0.07, peak: 0.38 },
    { at: 0.12, f: A5, hold: 0.03, tau: 0.11, peak: 0.42 },
  ],
  // A warm rising triad arpeggio - a small welcome.
  peerJoined: [
    { at: 0, f: A4, hold: 0.02, tau: 0.07, peak: 0.4 },
    { at: 0.1, f: CS5, hold: 0.02, tau: 0.08, peak: 0.4 },
    { at: 0.2, f: E5, hold: 0.03, tau: 0.12, peak: 0.42 },
  ],
  // Two unhurried falling notes, a fifth apart.
  peerLeft: [
    { at: 0, f: E5, hold: 0.02, tau: 0.08, peak: 0.4 },
    { at: 0.15, f: A4, hold: 0.03, tau: 0.12, peak: 0.4 },
  ],
  // A full descending cadence: triad down to the root, the longest cue.
  sessionEnded: [
    { at: 0, f: E5, hold: 0.02, tau: 0.08, peak: 0.4 },
    { at: 0.14, f: CS5, hold: 0.02, tau: 0.09, peak: 0.38 },
    { at: 0.28, f: A4, hold: 0.04, tau: 0.12, peak: 0.42 },
  ],
  // One neutral mid "pip" - an acknowledgement, not a fanfare.
  fileStarted: [{ at: 0, f: D5, hold: 0.02, tau: 0.06, peak: 0.34 }],
  // A rising fourth in a low, round register.
  fileSent: [
    { at: 0, f: A4, hold: 0.02, tau: 0.07, peak: 0.38 },
    { at: 0.1, f: D5, hold: 0.03, tau: 0.11, peak: 0.4 },
  ],
  // A rising fifth, brighter than fileSent so "got one" beats "sent one".
  fileReceived: [
    { at: 0, f: D5, hold: 0.02, tau: 0.07, peak: 0.4 },
    { at: 0.1, f: A5, hold: 0.03, tau: 0.11, peak: 0.42 },
  ],
  // A single continuous downward slide - deflating, but soft.
  fileFailed: [{ at: 0, f: D5, glideTo: A4, glideTime: 0.16, hold: 0.03, tau: 0.1, peak: 0.4 }],
  // Short low upward glide, a fourth.
  micOn: [{ at: 0, f: E4, glideTo: A4, glideTime: 0.09, hold: 0.02, tau: 0.07, peak: 0.42 }],
  micOff: [{ at: 0, f: A4, glideTo: E4, glideTime: 0.09, hold: 0.02, tau: 0.07, peak: 0.42 }],
  // Like the mic pair but higher and wider (a fifth), so they read as related.
  cameraOn: [{ at: 0, f: A4, glideTo: E5, glideTime: 0.1, hold: 0.02, tau: 0.08, peak: 0.4 }],
  cameraOff: [{ at: 0, f: E5, glideTo: A4, glideTime: 0.1, hold: 0.02, tau: 0.08, peak: 0.4 }],
  // A full-octave sweep: the "something big opened/closed" gesture.
  screenShareOn: [
    { at: 0, f: A4, glideTo: A5, glideTime: 0.16, hold: 0.03, tau: 0.11, peak: 0.38 },
  ],
  screenShareOff: [
    { at: 0, f: A5, glideTo: A4, glideTime: 0.16, hold: 0.03, tau: 0.11, peak: 0.38 },
  ],
  // Two quick low taps, like knuckles on a door: someone is asking to join.
  knock: [
    { at: 0, f: A3, hold: 0.015, tau: 0.05, peak: 0.5, cutoff: 1200 },
    { at: 0.16, f: A3, hold: 0.015, tau: 0.05, peak: 0.5, cutoff: 1200 },
  ],
  // Low, dull and falling - a soft "uh-oh", filtered darker than everything else.
  error: [
    { at: 0, f: E4, glideTo: CS4, glideTime: 0.12, hold: 0.03, tau: 0.13, peak: 0.46, cutoff: 1600 },
  ],
};

// ------------------------------------------------------------- pure scheduler

/**
 * Schedules one cue into an arbitrary context/destination and returns the
 * cue's duration in seconds (including the release tail, excluding any reverb
 * added downstream).
 *
 * Exported deliberately: the live engine and the verification script render
 * the *same* code path - the script through an OfflineAudioContext - so what
 * is asserted offline is exactly what plays live.
 */
export function scheduleCue(
  ctx: BaseAudioContext,
  destination: AudioNode,
  cue: SoundCue,
  when = 0,
): number {
  let end = 0;
  for (const note of CUES[cue]) {
    end = Math.max(end, scheduleNote(ctx, destination, note, when + note.at) - when);
  }
  return end;
}

function scheduleNote(
  ctx: BaseAudioContext,
  destination: AudioNode,
  note: NoteSpec,
  t0: number,
): number {
  const attack = Math.max(note.attack ?? 0.028, 0.02);
  const hold = note.hold ?? 0.02;
  const tau = note.tau ?? 0.08;
  const peak = note.peak ?? 0.4;
  const cutoff = note.cutoff ?? 2400;
  // ~7 time constants leaves the exponential release below one thousandth of
  // its peak, which is inaudible; only then are the oscillators stopped.
  const end = t0 + attack + hold + tau * 7;

  // Envelope: linear attack (>= 20 ms so a sine cannot click on), then an
  // exponential release via setTargetAtTime - the decay shape the ear expects.
  // Never an instantaneous step, never a ramp that lands exactly on zero.
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + attack);
  env.gain.setTargetAtTime(0, t0 + attack + hold, tau);

  // Tone shaping: a gentle, non-resonant lowpass that opens with the attack
  // and closes with the release, so the sound breathes instead of buzzing.
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(Math.max(cutoff * 0.55, 700), t0);
  filter.frequency.linearRampToValueAtTime(cutoff, t0 + attack + 0.02);
  filter.frequency.setTargetAtTime(Math.max(cutoff * 0.5, 650), t0 + attack + hold, tau * 1.4);

  filter.connect(env);
  env.connect(destination);

  // Warmth: two sines a few cents apart beat slowly against each other; a
  // quiet octave doubles as "air". Sine only - square/saw harmonics are harsh.
  const layers: { ratio: number; cents: number; gain: number }[] = [
    { ratio: 1, cents: -6, gain: 0.5 },
    { ratio: 1, cents: 6, gain: 0.5 },
    { ratio: 2, cents: 0, gain: 0.12 },
  ];

  const oscillators: OscillatorNode[] = [];
  for (const layer of layers) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.detune.value = layer.cents;
    osc.frequency.setValueAtTime(note.f * layer.ratio, t0);
    if (note.glideTo) {
      // Portamento instead of a pitch jump: exponential glide reads as one
      // smooth gesture rather than two separate beeps.
      osc.frequency.exponentialRampToValueAtTime(
        note.glideTo * layer.ratio,
        t0 + (note.glideTime ?? 0.1),
      );
    }
    const layerGain = ctx.createGain();
    layerGain.gain.value = layer.gain;
    osc.connect(layerGain);
    layerGain.connect(filter);
    osc.start(t0);
    osc.stop(end);
    oscillators.push(osc);
  }

  // Free the whole voice once the release has fully completed so nodes never
  // accumulate across a long session.
  oscillators[oscillators.length - 1].onended = () => {
    for (const osc of oscillators) osc.disconnect();
    filter.disconnect();
    env.disconnect();
  };

  return end;
}

// --------------------------------------------------------------- output chain

export type OutputChain = {
  /** Where voices connect. */
  input: AudioNode;
  /** Final gain before the destination; used for the unlock fade and mute. */
  master: GainNode;
  /** Seconds of reverb tail past the last voice. */
  tailSeconds: number;
};

/**
 * Shared master bus: dry + a subtle convolver tail into a soft-knee
 * compressor, then a quiet master gain.
 *
 * A convolver with a procedurally generated impulse response was chosen over
 * a feedback delay because a delay's discrete repeats sound metallic on short
 * chimes, while decaying noise gives a small, diffuse room. No file is
 * fetched - the impulse is synthesized into an AudioBuffer right here.
 *
 * Exported so the verification script can render cues through the exact
 * live signal chain inside an OfflineAudioContext.
 */
export function buildOutputChain(
  ctx: BaseAudioContext,
  destination: AudioNode,
  level = MASTER_LEVEL,
): OutputChain {
  const input = ctx.createGain();
  input.gain.value = 1;

  // Soft limiter, not a brick wall: wide knee, moderate ratio. Overlapping
  // cues get gently rounded off instead of clipping or pumping.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 30;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.22;

  const irSeconds = 0.7;
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulseResponse(ctx, irSeconds);

  const wet = ctx.createGain();
  wet.gain.value = 0.18; // subtle: space, not "reverb" as an effect

  const master = ctx.createGain();
  master.gain.value = level;

  input.connect(compressor);
  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(compressor);
  compressor.connect(master);
  master.connect(destination);

  return { input, master, tailSeconds: irSeconds + 0.3 };
}

/** Decaying stereo noise: a tiny, neutral room. */
function makeImpulseResponse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  const tau = seconds / 4.5;
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (rate * tau)) * 0.5;
    }
  }
  return buffer;
}

// ---------------------------------------------------------------- live engine

type Engine = { ctx: AudioContext; chain: OutputChain };

let engine: Engine | null = null;
let unlocked = false;
let primed = false;
let activeVoices = 0;
const lastPlayedAt = new Map<SoundCue, number>();

/** null = not yet read from storage. */
let muted: boolean | null = null;
const muteListeners = new Set<() => void>();

function readMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // Default is ON: the cues are quiet and carry real signal (a note arriving
    // while you look at another tab). Anyone who disagrees is one click and
    // one persisted preference away from silence.
    return window.localStorage.getItem(STORAGE_KEY) === "off";
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  if (muted === null) muted = readMuted();
  return muted;
}

export function setMuted(next: boolean) {
  muted = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "off" : "on");
  } catch {
    // Storage unavailable (private browsing): the choice won't persist.
  }
  // Duck the master immediately so an in-flight cue does not ring on after
  // the user asked for silence - still a ramp, never a step.
  if (engine) {
    const now = engine.ctx.currentTime;
    engine.chain.master.gain.setTargetAtTime(next ? 0 : MASTER_LEVEL, now, 0.02);
  }
  for (const listener of muteListeners) listener();
}

export function toggleMuted(): boolean {
  const next = !isMuted();
  setMuted(next);
  return next;
}

/** `useSyncExternalStore`-shaped; subscribing also primes gesture unlock. */
export function subscribeMuted(listener: () => void) {
  primeSoundEngine();
  muteListeners.add(listener);
  return () => {
    muteListeners.delete(listener);
  };
}

/**
 * Registers one-time gesture listeners that create and resume the shared
 * AudioContext. Browsers refuse audio before a user gesture, so the context
 * is never created eagerly, and a cue requested before unlock is dropped
 * silently rather than queued (a backlog of stale dings would be worse than
 * missing one).
 */
export function primeSoundEngine() {
  if (primed || typeof window === "undefined") return;
  primed = true;

  const unlock = () => {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // no Web Audio: the app simply stays silent
    try {
      if (!engine) {
        const ctx = new Ctor();
        const chain = buildOutputChain(ctx, ctx.destination, MASTER_LEVEL);
        // Fade the master in over ~30 ms so the very first cue cannot thump.
        chain.master.gain.setValueAtTime(0, ctx.currentTime);
        chain.master.gain.linearRampToValueAtTime(
          isMuted() ? 0 : MASTER_LEVEL,
          ctx.currentTime + 0.03,
        );
        engine = { ctx, chain };
      }
      void engine.ctx
        .resume()
        .then(() => {
          if (engine?.ctx.state === "running") {
            unlocked = true;
            remove();
          }
        })
        .catch(() => {
          // Still locked; the next gesture will try again.
        });
    } catch {
      // Constructing the context failed; never throw from a gesture handler.
    }
  };

  const remove = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("touchstart", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  window.addEventListener("touchstart", unlock);
}

/**
 * Plays a named cue. Always safe to call: before unlock, muted, during SSR or
 * over the voice cap it simply does nothing.
 */
export function playCue(cue: SoundCue) {
  if (typeof window === "undefined") return;
  primeSoundEngine();
  if (isMuted() || !unlocked || !engine || engine.ctx.state !== "running") return;

  // Collapse bursts: ten files finishing together should chime once, and a
  // hard voice cap keeps worst-case overlap well inside the compressor's
  // comfort zone.
  const now = performance.now();
  const last = lastPlayedAt.get(cue);
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return;
  if (activeVoices >= MAX_VOICES) return;
  lastPlayedAt.set(cue, now);
  activeVoices += 1;

  try {
    const duration = scheduleCue(engine.ctx, engine.chain.input, cue, engine.ctx.currentTime + 0.01);
    window.setTimeout(() => {
      activeVoices = Math.max(0, activeVoices - 1);
    }, (duration + 0.1) * 1000);
  } catch {
    activeVoices = Math.max(0, activeVoices - 1);
    // A scheduling failure is never worth surfacing to the user.
  }
}

/** Introspection for the verification script; not used by app code. */
export function getSoundDiagnostics() {
  return {
    primed,
    unlocked,
    activeVoices,
    muted: isMuted(),
    contextState: engine?.ctx.state ?? "none",
  };
}
