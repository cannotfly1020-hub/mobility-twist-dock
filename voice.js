/**
 * 🦴 柔軟性・しなりドック - Audio & Speech Engine (js/audio.js)
 * Web Audio APIによるシンセ効果音と、Web Speech APIによる音声ナビを一元管理します。
 */
(function() {
  'use strict';

  let audioCtx = null;

  /**
   * AudioContextの取得または遅延初期化（ユーザー操作後に再開）
   */
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  const AppAudio = {
    /**
     * 基本的なオシレーター発音関数
     * @param {number} freq 周波数 (Hz)
     * @param {number} dur 持続時間 (秒)
     * @param {string} type 波形 ('sine' | 'square' | 'triangle' | 'sawtooth')
     * @param {number} vol 音量 (0.0 - 1.0)
     */
    playTone(freq, dur, type = 'sine', vol = 0.1) {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);

        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start();
        osc.stop(ctx.currentTime + dur);
      } catch (e) {
        console.warn('Web Audio playTone error:', e);
      }
    },

    /**
     * ボタンタップ音（短くポップな高音）
     */
    playTap() {
      this.playTone(800, 0.05, 'sine', 0.08);
    },

    /**
     * 姿勢ロック完了音（高音ピロリン♪ 880Hz -> 1320Hz）
     */
    playLockSound() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1320, now + 0.08);

        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.25);
      } catch (e) {
        console.warn('playLockSound error:', e);
      }
    },

    /**
     * 測定終了ホイッスル（鋭い連続音）
     */
    playWhistle() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(2600, now);
        osc.frequency.setValueAtTime(2400, now + 0.15);

        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.35);
      } catch (e) {
        console.warn('playWhistle error:', e);
      }
    },

    /**
     * ドリルコンボ打楽器音（660Hz -> 990Hz）
     */
    playComboPing() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, now);
        osc.frequency.exponentialRampToValueAtTime(990, now + 0.12);

        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.2);
      } catch (e) {
        console.warn('playComboPing error:', e);
      }
    },

    /**
     * クリア祝勝ファンファーレ（和音アルペジオ）
     */
    playFanfare() {
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach((freq, index) => {
        setTimeout(() => {
          this.playTone(freq, 0.3, 'triangle', 0.15);
        }, index * 120);
      });
    },

    /**
     * Web Speech APIによる熱血音声ナビゲーション
     * @param {string} text 発話するテキスト
     * @param {boolean} cancel 既存の発話をキャンセルするかどうか
     */
    speak(text, cancel = true) {
      if (!('speechSynthesis' in window)) return;

      try {
        if (cancel) {
          window.speechSynthesis.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.15; // 小学生向けに少し早口でテンポ良く
        utterance.pitch = 1.1; // 明るく元気なピッチ
        utterance.lang = 'ja-JP';

        window.speechSynthesis.speak(utterance);
      } catch (e) {
        console.warn('SpeechSynthesis error:', e);
      }
    }
  };

  // グローバル公開
  window.AppAudio = AppAudio;

})();
