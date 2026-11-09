// Port of Sources/NW4R/Snd/SoundSystem.swift — SoundArchivePlayer + AX-style 32 kHz mixer in 3 ms frames,
// BasicSound/SeqSound and SoundHandle. Single-threaded on the web (no locks): the engine runs on the main thread and
// pushes rendered blocks to the audio worklet (see js/forecast/sound/SoundManager.js).
import { SeqFile, BankFile, DSPADPCM, SoundType } from './SoundArchive.js';
import { PCMWave } from './Channel.js';
import { SeqPlayer } from './SeqPlayer.js';
import { FxReverbHi } from './FxReverbHi.js';
import { PanCurve } from './SndTables.js';

/** A bank with its wave data; waves are decoded from DSP-ADPCM on first use and cached. */
export class LoadedBank {
  constructor(file, waveData) { this.file = file; this.waveData = waveData; this.cache = new Map(); }
  wave(i) {
    const hit = this.cache.get(i);
    if (hit) return hit;
    if (i >= this.file.waves.length) return null;
    const info = this.file.waves[i];
    const n = info.loopEndSample, wd = this.waveData;
    const chans = [];
    for (let c = 0; c < info.channels; c++) {
      const off = info.channelDataOffsets[c];
      if (info.format === 2) {
        chans.push(DSPADPCM.decode(wd, off, n, info.adpcm[c], info.initialHistory[c]));
      } else if (info.format === 1) {
        const a = new Float32Array(n);
        for (let k = 0; k < n; k++) { const o = off + k * 2; a[k] = o + 1 < wd.length ? (((wd[o] << 24) | (wd[o + 1] << 16)) >> 16) / 32768 : 0; }
        chans.push(a);
      } else {
        const a = new Float32Array(n);
        for (let k = 0; k < n; k++) a[k] = off + k < wd.length ? ((wd[off + k] << 24) >> 24) / 128 : 0;
        chans.push(a);
      }
    }
    const w = new PCMWave(chans, info.sampleRate, info.loop, info.loopStartSample, n);
    this.cache.set(i, w);
    return w;
  }
}

/** nw4r BasicSound/SeqSound: owns a SeqPlayer plus handle-level volume/pitch/pan, fades and pause. */
export class SeqSound {
  constructor(id, player, playerID, priority, volume, order) {
    this.soundID = id; this.player = player; this.playerID = playerID; this.priority = priority;
    this.initVolume = volume; this.startOrder = order;
    // MoveValue-style ramps, advanced once per game frame (BasicSound::Update)
    this.userVolume = 1; this.userVolumeTarget = 1; this.userVolumeFrames = 0;
    this.fadeVolume = 1; this.fadeTarget = 1; this.fadeFrames = 0; this.stopAfterFade = false;
    this.pauseVolume = 1; this.pauseTarget = 1; this.pauseFrames = 0; this.pausing = false;
    this.pitch = 1; this.pan = 0;
    this.archiveTag = 0;
  }
  get isFinished() { return this.player.finished && !this.hasSoundingChannels; }
  get hasSoundingChannels() { return this.player.tracks.some((t) => t.channels.some((c) => c.active)); }

  gameFrameUpdate() {
    const step = (v, t, f) => f > 0 ? [v + (t - v) / f, f - 1] : [t, 0];
    [this.userVolume, this.userVolumeFrames] = step(this.userVolume, this.userVolumeTarget, this.userVolumeFrames);
    [this.fadeVolume, this.fadeFrames] = step(this.fadeVolume, this.fadeTarget, this.fadeFrames);
    [this.pauseVolume, this.pauseFrames] = step(this.pauseVolume, this.pauseTarget, this.pauseFrames);
    if (this.pausing && this.pauseFrames === 0) this.player.paused = true;
    this.applyParams();
  }
  applyParams() {
    this.player.volume = this.initVolume * this.userVolume * this.fadeVolume * this.pauseVolume;
    this.player.pitch = this.pitch; this.player.pan = this.pan;
  }
}

/** Handle (nw4r::snd::SoundHandle). Detaches automatically when the sound ends. */
export class SoundHandle {
  constructor() { this.system = null; this.sound = null; }
  get isAttached() { return this.sound !== null; }
  get soundID() { return this.sound ? this.sound.soundID : -1; }

  setVolume(v, frames = 0) {
    const s = this.sound; if (!s) return;
    s.userVolumeTarget = v; s.userVolumeFrames = frames; if (frames === 0) s.userVolume = v; s.applyParams();
  }
  setPitch(p) { const s = this.sound; if (s) { s.pitch = p; s.applyParams(); } }
  setPan(p) { const s = this.sound; if (s) { s.pan = p; s.applyParams(); } }
  /** BasicSound::Stop(fadeFrames) */
  stop(fadeFrames = 0) { if (this.system) this.system.stopSound(this, fadeFrames); }
  /** BasicSound::Pause(flag, fadeFrames) */
  pause(flag, fadeFrames = 0) {
    const s = this.sound; if (!s) return;
    if (flag) {
      s.pausing = true; s.pauseTarget = 0; s.pauseFrames = fadeFrames;
      if (fadeFrames === 0) { s.pauseVolume = 0; s.player.paused = true; }
    } else {
      s.pausing = false; s.player.paused = false; s.pauseTarget = 1; s.pauseFrames = fadeFrames;
      if (fadeFrames === 0) s.pauseVolume = 1;
    }
    s.applyParams();
  }
  detach() { this.sound = null; }
}

export class SoundSystem {
  constructor(tables, reverbParam = null) {
    this.tables = tables;
    this.globalVars = new Int16Array(16).fill(-1);
    this.archives = [];
    this.seqCache = new Map(); this.bankCache = new Map();
    this.channels = [];
    this.sounds = [];
    this.handles = [];   // [handle, sound]
    this.order = 0;
    this.masterVolume = 1;
    let p = {};
    if (reverbParam && reverbParam.length >= 6) {
      const r = reverbParam;
      p = { preDelay: r[0], time: r[1], coloration: r[2], damping: r[3], crosstalk: r[4], outGain: r[5] };
    }
    this.reverb = new FxReverbHi(SoundSystem.outputRate, p);
    const n = SoundSystem.samplesPerFrame;
    this._L = new Float32Array(n); this._R = new Float32Array(n); this._AL = new Float32Array(n); this._AR = new Float32Array(n);
    this._pend = 0;   // samples left in the current frame buffer
  }

  /** Register an archive; returns its index. */
  addArchive(a) { this.archives.push(a); return this.archives.length - 1; }
  archive(i) { return this.archives[i]; }
  addChannel(c) { this.channels.push(c); }

  /** SoundArchivePlayer::StartSound. Returns false if the sound could not start. */
  startSound(ai, id, handle = null) {
    const a = this.archives[ai];
    if (!a || id < 0 || id >= a.sounds.length) return false;
    const info = a.sounds[id];
    if (info.type !== SoundType.seq) return false;
    const key = `${ai}:`;
    const seq = this.cachedSeq(key + 'f' + info.fileID, a, info.fileID);
    const bank = this.cachedBank(key + 'b' + info.seqBankID, a, info.seqBankID);
    if (!seq || !bank) return false;
    if (handle) this.stopSound(handle, 0);
    // Player capacity (PlayerInfo.playableSoundCount): evict lowest priority, then oldest.
    const cap = info.playerID < a.players.length ? Math.max(a.players[info.playerID].playableSoundCount, 1) : 1;
    const same = this.sounds.filter((s) => s.playerID === info.playerID && !s.player.finished && s.startOrder >= 0 && s.archiveTag === ai);
    if (same.length >= cap) {
      let victim = same[0];
      for (const s of same) if (s.priority < victim.priority || (s.priority === victim.priority && s.startOrder < victim.startOrder)) victim = s;
      if (victim.priority > info.playerPriority) return false;
      this.kill(victim);
    }
    const curve = Object.values(PanCurve).includes(info.panCurve) ? info.panCurve : PanCurve.sqrt;
    const player = new SeqPlayer(this, seq, bank, info.seqLabelOffset, info.seqAllocTrack, curve);
    this.order++;
    const s = new SeqSound(id, player, info.playerID, info.playerPriority, info.volume / 127, this.order);
    s.archiveTag = ai;
    s.applyParams();
    this.sounds.push(s);
    if (handle) { handle.system = this; handle.sound = s; this.handles.push([handle, s]); }
    return true;
  }

  cachedSeq(k, a, f) {
    let s = this.seqCache.get(k);
    if (s) return s;
    const d = a.fileData(f);
    if (!d) return null;
    try { s = new SeqFile(d); } catch { return null; }
    this.seqCache.set(k, s); return s;
  }
  cachedBank(k, a, b) {
    let s = this.bankCache.get(k);
    if (s) return s;
    if (b >= a.banks.length) return null;
    const d = a.fileData(a.banks[b].fileID), w = a.waveData(a.banks[b].fileID);
    if (!d || !w) return null;
    let f; try { f = new BankFile(d); } catch { return null; }
    s = new LoadedBank(f, w);
    this.bankCache.set(k, s); return s;
  }

  stopSound(h, fadeFrames) {
    const s = h.sound;
    if (!s) return;
    if (fadeFrames > 0) { s.fadeTarget = 0; s.fadeFrames = fadeFrames; s.stopAfterFade = true; }
    else this.kill(s);
  }
  kill(s) {
    // nw4r stop: tracks release with the fastest release (127) → near-instant fade, no click
    for (const t of s.player.tracks) if (t.open) { t.releaseAll(127); t.freeAll(); t.open = false; }
    s.player.finished = true;
    this.sounds = this.sounds.filter((x) => x !== s);
    this.handles = this.handles.filter(([h, x]) => { if (x === s) { h.sound = null; return false; } return true; });
  }

  /** BasicSound/SoundArchivePlayer::Update — call once per game frame (60 Hz). */
  gameFrameUpdate() {
    for (const s of this.sounds.slice()) {
      s.gameFrameUpdate();
      if (s.stopAfterFade && s.fadeFrames === 0 && s.fadeVolume === 0) this.kill(s);
    }
    for (const s of this.sounds.slice()) if (s.isFinished) this.kill(s);
  }

  /** Render one AX frame (96 samples) into this._L/_R. */
  renderFrame() {
    const n = SoundSystem.samplesPerFrame;
    const L = this._L, R = this._R, AL = this._AL, AR = this._AR;
    L.fill(0); R.fill(0); AL.fill(0); AR.fill(0);
    for (const s of this.sounds) s.player.update();
    for (const c of this.channels) c.update(this.tables, true);
    for (const c of this.channels) c.mix(L, R, AL, AR, n, SoundSystem.outputRate);
    this.channels = this.channels.filter((c) => c.active);
    // AUX C → FxReverbHi (installed by sound_manager Init via AxManager::AppendEffect(AUX_C, ...))
    this.reverb.process(AL, AR);
    for (let i = 0; i < n; i++) { L[i] += AL[i]; R[i] += AR[i]; }
  }

  /** Pull `count` stereo samples at 32 kHz into Float32Arrays `left`/`right` from `offset`. */
  render(count, left, right, offset = 0) {
    const n = SoundSystem.samplesPerFrame, mv = this.masterVolume;
    let written = 0;
    while (written < count) {
      if (this._pend === 0) { this.renderFrame(); this._pend = n; }
      const k = Math.min(count - written, this._pend);
      const start = n - this._pend;
      for (let i = 0; i < k; i++) {
        left[offset + written + i] = Math.max(-1, Math.min(1, this._L[start + i] * mv));
        right[offset + written + i] = Math.max(-1, Math.min(1, this._R[start + i] * mv));
      }
      this._pend -= k;
      written += k;
    }
  }

  get activeChannelCount() { return this.channels.length; }
  get activeSoundCount() { return this.sounds.length; }
}
SoundSystem.outputRate = 32000;          // AX mixer rate
SoundSystem.samplesPerFrame = 96;        // 3 ms at 32 kHz
