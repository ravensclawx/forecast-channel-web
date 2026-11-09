// Port of Sources/Forecast/Sound/SoundManager.swift — sound_manager.cpp (main.dol 0x800418A8–0x800429A4).
// The channel calls these by sound ID (rev_wtr.brsar sound indices, see `SE`).
//
// Web audio path: the NW4R engine (SoundSystem) runs on the main thread; `pump()` (called from update(), i.e. once per
// game frame) renders 32 kHz stereo ahead of playback and posts the blocks to an AudioWorklet (worklet.js) — or a
// ScriptProcessor fallback — which plays them, resampling only if the AudioContext could not be created at 32 kHz.
import { RVLError } from '../../rvl/BinaryReader.js';
import { CXHuffman } from '../../rvl/CX.js';
import { SndTables } from '../../nw4r/snd/SndTables.js';
import { SoundArchive } from '../../nw4r/snd/SoundArchive.js';
import { SoundSystem, SoundHandle } from '../../nw4r/snd/SoundSystem.js';

export { SoundHandle };

/** rev_wtr.brsar sound IDs (names from the archive's SYMB block). */
export const SE = Object.freeze({
  cikyugi: 0, earthSel: 1, earthZoom1: 2, earthZoom2: 3, earthZoom3: 4, earthZoom4: 5, earthZoom5: 6, earthZoom6: 7,
  earthZoom7: 8, earthZoom8: 9, earthZoom9: 10, earthZoom10: 11, earthAngle1: 12, earthAngle2: 13, earthAngle3: 14,
  earthAngle4: 15, earthAngle5: 16, earthAngle6: 17, earthAxis: 0x12, earthUndo: 0x13, earthKaiten: 0x14, earthTukami: 0x15,
  bScroll: 22, comReceive: 23, comSuccess: 24, comError: 25, comButton: 26, comButtonB: 27,
  bgmMorningYohou: 28, bgmMorningCikyu: 29, bgmMorningSelf: 30, bgmNightYohou: 31, bgmNightCikyu: 32, bgmNightSelf: 33,
  bgmOption: 34, ketteiB0: 35, ketteiB1: 36, ketteiB2: 37, cancel: 0x26, cancelBig: 39, menuSel: 40, tenki: 41, tenki2: 42,
  tenki2Ret: 43, kion: 44, placeChange: 45, placeSel1: 46, placeSel2: 47, placeScroll: 48, rain: 49, thunder: 50,
});

// TMD content indices (Assets.Content)
const CONTENT_MAIN_DOL = 1, CONTENT_HOME_BUTTON = 6, CONTENT_WEATHER = 9;

/** Target audio buffered ahead of playback (samples at 32 kHz). */
const LEAD_SAMPLES = 4096;     // ~128 ms
const BLOCK = 512;

export class SoundManager {
  /**
   * fn_800418A8 Init: opens rev_wtr.brsar (content 9) and the HOME Menu SE archive.
   * `assets` must provide `title.content(index)` → Uint8Array and `archive(index)` → ARCArchive (js Assets port).
   */
  constructor(assets) {
    const dol = assets.title.content(CONTENT_MAIN_DOL);
    const tables = new SndTables(dol);
    /** @type {SoundSystem} */
    this.system = new SoundSystem(tables, tables.channelReverbParam);
    const rsar = assets.archive(CONTENT_WEATHER).file('/rev_wtr.brsar');
    if (!rsar) throw RVLError.missing('Cannot open Sound Archive File');   // OSPanic at sound_manager.cpp:0x19D
    this.weatherArchive = this.system.addArchive(new SoundArchive(rsar));
    this.homeArchive = null;
    try {
      const huf = assets.archive(CONTENT_HOME_BUTTON).file('/HomeButton3/Huf8_HomeButtonSe.brsar');
      if (huf) this.homeArchive = this.system.addArchive(new SoundArchive(CXHuffman.uncompress(huf)));
    } catch { /* optional */ }

    /** lbl_80330C4C — the shared SE handle used by PlaySE. */
    this.seHandle = new SoundHandle();
    /** lbl_801F76D4[4] — BGM layers: [0] SELF, [1] YOHOU (forecast), [2] CIKYU (globe), [3] OPTION. */
    this.bgmHandles = [new SoundHandle(), new SoundHandle(), new SoundHandle(), new SoundHandle()];
    /** lbl_80330C2C — the globe rotation loop (SimpleGlobe::UpdateRotateSound). */
    this.rotateHandle = new SoundHandle();
    /** Volume faders updated in fn_80041F54: {step, current, target, active} ×3. */
    this.faders = [0, 1, 2].map(() => ({ step: 0, current: 1, target: 1, active: false }));
    /** lbl_803301E8 — SCGetSoundMode: true = stereo. */
    this.stereo = true;

    // Output state
    this.ctx = null; this.node = null; this.mode = null;
    this.written = 0;          // samples posted to the output
    this.startTime = 0;        // ctx.currentTime when posting started
    this.outRate = SoundSystem.outputRate;
    this._fallbackQueue = [];  // ScriptProcessor fallback: [{l, r}]
  }

  /**
   * Start audio output. Must be called from a user gesture (autoplay policy). Safe to call more than once
   * (resumes a suspended context).
   */
  async startOutput() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC({ sampleRate: SoundSystem.outputRate, latencyHint: 'interactive' }); }
    catch { ctx = new AC({ latencyHint: 'interactive' }); }
    this.ctx = ctx;
    this.outRate = ctx.sampleRate;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
        this.node = new AudioWorkletNode(ctx, 'fc-sound', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
          processorOptions: { sourceRate: SoundSystem.outputRate } });
        this.node.connect(ctx.destination);
        this.mode = 'worklet';
      } catch { this.node = null; }
    }
    if (!this.node) {
      // ScriptProcessor fallback (resamples by nearest-linear in the callback).
      const sp = ctx.createScriptProcessor(2048, 0, 2);
      const ratio = SoundSystem.outputRate / ctx.sampleRate;
      let cur = null, pos = 0;
      sp.onaudioprocess = (e) => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < L.length; i++) {
          if (!cur || pos >= cur.l.length - 1) {
            if (cur) pos -= cur.l.length;
            cur = this._fallbackQueue.shift() ?? null;
            if (!cur) { L.fill(0, i); R.fill(0, i); pos = 0; return; }
            if (pos < 0) pos = 0;
          }
          const k = Math.trunc(pos), f = pos - k;
          const k1 = Math.min(k + 1, cur.l.length - 1);
          L[i] = cur.l[k] + (cur.l[k1] - cur.l[k]) * f;
          R[i] = cur.r[k] + (cur.r[k1] - cur.r[k]) * f;
          pos += ratio;
        }
      };
      sp.connect(ctx.destination);
      this.node = sp;
      this.mode = 'script';
    }
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch { /* resumes on next gesture */ } }
    this.startTime = ctx.currentTime;
    this.written = 0;
  }

  /** Render ahead and post blocks so ~LEAD_SAMPLES of audio are queued. Called from update(). */
  pump() {
    const ctx = this.ctx;
    if (!ctx || !this.node || ctx.state !== 'running') return;
    const rate = SoundSystem.outputRate;
    const played = Math.max(0, (ctx.currentTime - this.startTime) * rate);
    if (this.written < played) this.written = Math.ceil(played);   // underrun: don't build up latency
    let need = Math.ceil(played + LEAD_SAMPLES - this.written);
    while (need > 0) {
      const n = BLOCK;
      const l = new Float32Array(n), r = new Float32Array(n);
      this.system.render(n, l, r);
      if (!this.stereo) for (let i = 0; i < n; i++) { const m = (l[i] + r[i]) * 0.5; l[i] = m; r[i] = m; }
      if (this.mode === 'worklet') this.node.port.postMessage({ l, r }, [l.buffer, r.buffer]);
      else this._fallbackQueue.push({ l, r });
      this.written += n;
      need -= n;
    }
  }

  // MARK: - sound_manager.cpp API

  /** fn_80042520 PlaySE(id) / fn_80042640 PlaySE(id, volume, pitch, pan). */
  playSE(id, volume = 1, pitch = 1, pan = 0) {
    this.system.startSound(this.weatherArchive, id, this.seHandle);
    this.seHandle.setVolume(volume);
    this.seHandle.setPitch(pitch);
    this.seHandle.setPan(pan);
  }

  /** fn_800427A8 StartSound(handle, id). */
  startSound(handle, id) { return this.system.startSound(this.weatherArchive, id, handle); }
  /** fn_800428A4 SetVolume(handle, v). */
  setVolume(h, v, frames = 0) { h.setVolume(v, frames); }
  /** fn_80042964 SetPitch(handle, p). */
  setPitch(h, p) { h.setPitch(p); }
  /** fn_80042984 SetPan(handle, p). */
  setPan(h, p) { h.setPan(p); }
  /** fn_80042810 Stop(handle, fadeFrames). */
  stop(h, fadeFrames = 0) { h.stop(fadeFrames); }
  /** fn_80042830 Pause(handle, flag, fadeFrames). */
  pause(h, flag, fadeFrames = 0) { h.pause(flag, fadeFrames); }
  /** fn_800429A4 IsAttached(handle). */
  isAttached(h) { return h.isAttached; }

  /** HOME Menu SE (HOMESE_* in Huf8_HomeButtonSe.brsar). */
  playHomeSE(id) { if (this.homeArchive !== null) this.system.startSound(this.homeArchive, id, null); }

  /** fn_80041F54 Update — once per game frame: step the three faders, then SoundArchivePlayer::Update; then feed audio. */
  update() {
    for (const f of this.faders) {
      const target = f.active ? f.target : 1;
      if (f.current < target) f.current = Math.min(f.current + f.step, target);
      else if (f.current > target) f.current = Math.max(f.current - f.step, target);
    }
    this.system.gameFrameUpdate();
    this.pump();
  }

  /** SimpleGlobe::UpdateRotateSound (fn_800410A4): seId 0x14, volume speed/5, pitch speed/90 + 0.5. */
  updateRotateSound(speed) {
    if (speed < 1) return;
    if (!this.rotateHandle.isAttached) this.startSound(this.rotateHandle, SE.earthKaiten);
    this.rotateHandle.setVolume(Math.min(speed / 5, 1));
    this.rotateHandle.setPitch(Math.min(speed / 90, 1) + 0.5);
    this.rotateHandle.setPan(0);
  }

  /** Suspend/resume output (page hidden). */
  async suspend() { if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend(); }
  async resume() {
    if (this.ctx && this.ctx.state !== 'running') { await this.ctx.resume(); this.startTime = this.ctx.currentTime; this.written = 0; }
  }
}
