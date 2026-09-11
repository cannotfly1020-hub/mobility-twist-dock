/**
 * 🦴 柔軟性・しなりドック - Audio & Speech Engine (js/audio.js)
 * Web Audio APIによるシンセ効果音と、Web Speech APIによる音声ナビを一元管理します。
 * 
 * Features:
 * - Robust AudioContext state management with suspend/resume recovery
 * - Parameter validation (frequency, duration, volume)
 * - Precise Web Audio API scheduling for fanfare playback
 * - SpeechSynthesis lifecycle tracking to prevent orphaned utterances
 * - Smooth exponential fade-out using setTargetAtTime
 * - Configurable audio presets for consistent sound design
 */
(function() {
  'use strict';

  // ============================================
  // CONFIGURATION & STATE
  // ============================================
  
  const AUDIO_CONFIG = {
    maxFrequency: 20000,
    minFrequency: 20,
    contextTimeout: 5000,
    speechLang: 'ja-JP',
    speechRate: 1.15,
    speechPitch: 1.1,
  };

  const AUDIO_PRESETS = {
    tap: { freq: 800, dur: 0.05, type: 'sine', vol: 0.08 },
    lock: { freqStart: 880, freqEnd: 1320, dur: 0.25, type: 'triangle', vol: 0.12 },
    whistle: { freqStart: 2600, freqEnd: 2400, dur: 0.35, type: 'sawtooth', vol: 0.15 },
    comboPing: { freqStart: 660, freqEnd: 990, dur: 0.2, type: 'sine', vol: 0.15 },
    fanfare: { notes: [523.25, 659.25, 783.99, 1046.50], dur: 0.3, type: 'triangle', vol: 0.15, spacing: 0.12 }
  };

  // ============================================
  // AUDIO CONTEXT STATE MACHINE
  // ============================================

  const AudioStateManager = {
    state: 'uninitialized', // uninitialized | created | suspended | running | closed | failed
    ctx: null,

    /**
     * Initialize AudioContext on first user interaction
     */
    async init() {
      if (this.state !== 'uninitialized') return this.ctx;
      
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          this.state = 'failed';
          console.error('AudioContext not supported in this browser.');
          return null;
        }

        this.ctx = new AudioContextClass();
        this.state = 'created';
        
        // Bind resume-on-user-interaction fallback for iOS
        if (this.ctx.state === 'suspended') {
          document.addEventListener('click', () => this.ensureRunning(), { once: true });
        }
        
        return this.ctx;
      } catch (err) {
        this.state = 'failed';
        console.error('AudioContext initialization failed:', err);
        return null;
      }
    },

    /**
     * Ensure context is running; retry on failure
     */
    async ensureRunning() {
      if (!this.ctx && !await this.init()) return null;
      
      if (this.ctx.state === 'running') return this.ctx;
      
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
          this.state = 'running';
          return this.ctx;
        } catch (err) {
          this.state = 'failed';
          console.error('AudioContext resume failed:', err);
          return null;
        }
      }
      
      return this.ctx;
    },

    close() {
      if (this.ctx) {
        try {
          this.ctx.close();
          this.state = 'closed';
        } catch (err) {
          console.warn('Error closing AudioContext:', err);
        }
      }
    }
  };

  // ============================================
  // VALIDATION HELPERS
  // ============================================

  function validateFrequency(freq) {
    if (!Number.isFinite(freq) || freq < AUDIO_CONFIG.minFrequency || freq > AUDIO_CONFIG.maxFrequency) {
      console.warn(`Invalid frequency: ${freq}. Must be ${AUDIO_CONFIG.minFrequency}–${AUDIO_CONFIG.maxFrequency} Hz.`);
      return false;
    }
    return true;
  }

  function validateDuration(dur) {
    if (!Number.isFinite(dur) || dur <= 0) {
      console.warn(`Invalid duration: ${dur}. Must be > 0 seconds.`);
      return false;
    }
    return true;
  }

  function validateVolume(vol) {
    if (!Number.isFinite(vol) || vol < 0 || vol > 1) {
      console.warn(`Invalid volume: ${vol}. Must be 0–1.`);
      return false;
    }
    return true;
  }

  // ============================================
  // CORE AUDIO ENGINE
  // ============================================

  const AppAudio = {
    currentUtterance: null,

    /**
     * Core tone synthesis with parameter validation
     * @param {number} freq - Frequency in Hz (20–20000)
     * @param {number} dur - Duration in seconds (> 0)
     * @param {string} type - Waveform type ('sine' | 'square' | 'triangle' | 'sawtooth')
     * @param {number} vol - Volume (0.0–1.0)
     * @param {number} [startTime] - Optional Web Audio API start time (for scheduling)
     */
    async playTone(freq, dur, type = 'sine', vol = 0.1, startTime = null) {
      if (!validateFrequency(freq) || !validateDuration(dur) || !validateVolume(vol)) {
        return;
      }

      try {
        const ctx = await AudioStateManager.ensureRunning();
        if (!ctx) return;

        const now = startTime || ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);

        gain.gain.setValueAtTime(vol, now);
        // Use setTargetAtTime for smoother exponential decay instead of exponentialRampToValueAtTime
        gain.gain.setTargetAtTime(0.00001, now + (dur * 0.8), 0.05);
        
        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + dur);
      } catch (err) {
        console.error('playTone failed:', err);
      }
    },

    /**
     * Button tap sound（短くポップな高音）
     */
    async playTap() {
      const p = AUDIO_PRESETS.tap;
      return this.playTone(p.freq, p.dur, p.type, p.vol);
    },

    /**
     * Pose lock completion sound（高音ピロリン♪ 880Hz -> 1320Hz）
     */
    async playLockSound() {
      try {
        const ctx = await AudioStateManager.ensureRunning();
        if (!ctx) return;

        const p = AUDIO_PRESETS.lock;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = p.type;
        osc.frequency.setValueAtTime(p.freqStart, now);
        osc.frequency.exponentialRampToValueAtTime(p.freqEnd, now + (p.dur * 0.4));

        gain.gain.setValueAtTime(p.vol, now);
        gain.gain.setTargetAtTime(0.00001, now + (p.dur * 0.8), 0.05);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + p.dur);
      } catch (err) {
        console.error('playLockSound failed:', err);
      }
    },

    /**
     * Measurement end whistle（鋭い連続音）
     */
    async playWhistle() {
      try {
        const ctx = await AudioStateManager.ensureRunning();
        if (!ctx) return;

        const p = AUDIO_PRESETS.whistle;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = p.type;
        osc.frequency.setValueAtTime(p.freqStart, now);
        osc.frequency.exponentialRampToValueAtTime(p.freqEnd, now + (p.dur * 0.4));

        gain.gain.setValueAtTime(p.vol, now);
        gain.gain.setTargetAtTime(0.00001, now + (p.dur * 0.8), 0.05);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + p.dur);
      } catch (err) {
        console.error('playWhistle failed:', err);
      }
    },

    /**
     * Drill combo ping（660Hz -> 990Hz）
     */
    async playComboPing() {
      try {
        const ctx = await AudioStateManager.ensureRunning();
        if (!ctx) return;

        const p = AUDIO_PRESETS.comboPing;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = p.type;
        osc.frequency.setValueAtTime(p.freqStart, now);
        osc.frequency.exponentialRampToValueAtTime(p.freqEnd, now + p.dur);

        gain.gain.setValueAtTime(p.vol, now);
        gain.gain.setTargetAtTime(0.00001, now + (p.dur * 0.8), 0.05);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + p.dur);
      } catch (err) {
        console.error('playComboPing failed:', err);
      }
    },

    /**
     * Fanfare arpeggio using Web Audio API scheduling for precise timing
     * Uses audioContext.currentTime for sub-millisecond accuracy instead of setTimeout
     */
    async playFanfare() {
      try {
        const ctx = await AudioStateManager.ensureRunning();
        if (!ctx) return;

        const p = AUDIO_PRESETS.fanfare;
        const now = ctx.currentTime;

        p.notes.forEach((freq, index) => {
          const startTime = now + (index * p.spacing);
          this.playTone(freq, p.dur, p.type, p.vol, startTime);
        });
      } catch (err) {
        console.error('playFanfare failed:', err);
      }
    },

    /**
     * Web Speech API text-to-speech with lifecycle management
     * @param {string} text - Text to speak
     * @param {boolean} [cancel=true] - Cancel any ongoing utterance
     */
    async speak(text, cancel = true) {
      if (!('speechSynthesis' in window)) {
        console.warn('Web Speech API not supported in this browser.');
        return;
      }

      try {
        if (cancel && this.currentUtterance) {
          window.speechSynthesis.cancel();
          this.currentUtterance = null;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = AUDIO_CONFIG.speechRate;
        utterance.pitch = AUDIO_CONFIG.speechPitch;
        utterance.lang = AUDIO_CONFIG.speechLang;

        utterance.onend = () => {
          this.currentUtterance = null;
        };

        utterance.onerror = (event) => {
          console.error(`Speech synthesis error (${event.error}):`, event);
          this.currentUtterance = null;
        };

        this.currentUtterance = utterance;
        window.speechSynthesis.speak(utterance);
      } catch (err) {
        console.error('SpeechSynthesis error:', err);
      }
    },

    /**
     * Clean up resources on app unload
     */
    destroy() {
      if (this.currentUtterance) {
        window.speechSynthesis.cancel();
        this.currentUtterance = null;
      }
      AudioStateManager.close();
    }
  };

  // ============================================
  // NAMESPACE & EXPORT
  // ============================================

  // Backward compatibility: attach to global window
  window.AppAudio = AppAudio;

  // Clean up on page unload
  window.addEventListener('beforeunload', () => AppAudio.destroy());

})();
