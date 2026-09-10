/**
 * 柔軟性・しなりドック - 音声・効果音マネージャー
 * Web Audio API (SE) & Web Speech API (音声ガイド) の統合管理
 */
const AppAudio = {
  ctx: null,
  isUnlocked: false,

  /**
   * AudioContextの安全な初期化およびブラウザ自動再生制限の解除
   */
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      const resumeHandler = () => {
        this.ctx.resume().then(() => {
          this.isUnlocked = true;
          window.removeEventListener('click', resumeHandler);
          window.removeEventListener('touchstart', resumeHandler);
        });
      };
      window.addEventListener('click', resumeHandler, { once: true });
      window.addEventListener('touchstart', resumeHandler, { once: true });
    } else if (this.ctx && this.ctx.state === 'running') {
      this.isUnlocked = true;
    }
  },

  /**
   * 汎用トーン発振メソッド
   * @param {number} freq 周波数 (Hz)
   * @param {string} type 波形種別 ('sine', 'square', 'triangle', 'sawtooth')
   * @param {number} duration 継続時間 (秒)
   * @param {number} startTime 再生開始ディレイ (秒)
   * @param {number} gainValue 最大音量 (0.0 - 1.0)
   */
  playTone(freq, type = 'sine', duration = 0.15, startTime = 0, gainValue = 0.25) {
    this.init();
    if (!this.ctx) return;

    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime + startTime);

      // エンベロープ設定 (アタック・ディケイによるクリックノイズ防止)
      gain.gain.setValueAtTime(0.0001, this.ctx.currentTime + startTime);
      gain.gain.exponentialRampToValueAtTime(gainValue, this.ctx.currentTime + startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + startTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(this.ctx.currentTime + startTime);
      osc.stop(this.ctx.currentTime + startTime + duration + 0.05);
    } catch (e) {
      console.warn('Audio playTone error:', e);
    }
  },

  /**
   * ロック完了音 (ピロリン♪ 軽快な上昇アルペジオ)
   */
  playLockSound() {
    this.playTone(523.25, 'triangle', 0.08, 0.0, 0.2);  // C5
    this.playTone(659.25, 'triangle', 0.08, 0.07, 0.25); // E5
    this.playTone(783.99, 'sine', 0.16, 0.14, 0.3);      // G5
  },

  /**
   * 測定終了ホイッスル (ピピッ！ 審判・コーチ風の鋭い笛音)
   */
  playWhistle() {
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      // 1回目の短い吹き
      this.playTone(2100, 'square', 0.1, 0.0, 0.25);
      this.playTone(2150, 'sawtooth', 0.1, 0.0, 0.15);

      // 2回目の長い吹き
      this.playTone(2100, 'square', 0.32, 0.15, 0.3);
      this.playTone(2150, 'sawtooth', 0.32, 0.15, 0.2);
    } catch (e) {
      console.warn('Audio playWhistle error:', e);
    }
  },

  /**
   * ドリルコンボ音 (パチンッ！ 軽快で爽快なヒット音)
   */
  playComboPing(combo = 1) {
    // コンボ数に応じて基音をピッチアップ (上限設定あり)
    const pitchOffset = Math.min(combo * 40, 480);
    const baseFreq = 880 + pitchOffset; // A5基準

    this.playTone(baseFreq, 'triangle', 0.09, 0.0, 0.3);
    this.playTone(baseFreq * 1.5, 'sine', 0.12, 0.03, 0.2);
  },

  /**
   * クリアファンファーレ音 (勝利と達成感を伝えるブラス風メロディ)
   */
  playFanfare() {
    const notes = [
      { f: 523.25, d: 0.12, t: 0.00 }, // C5
      { f: 523.25, d: 0.12, t: 0.12 }, // C5
      { f: 523.25, d: 0.12, t: 0.24 }, // C5
      { f: 659.25, d: 0.28, t: 0.36 }, // E5
      { f: 587.33, d: 0.12, t: 0.65 }, // D5
      { f: 659.25, d: 0.12, t: 0.77 }, // E5
      { f: 783.99, d: 0.50, t: 0.89 }, // G5
    ];

    notes.forEach(n => {
      this.playTone(n.f, 'triangle', n.d, n.t, 0.28);
      this.playTone(n.f * 1.005, 'sawtooth', n.d, n.t, 0.12);
    });
  },

  /**
   * 音声読み上げ (Web Speech API)
   * 重複発声を防止し、小学生が聞き取りやすいトーン・テンポで案内
   * @param {string} text 読み上げるテキスト
   */
  speak(text) {
    if (!('speechSynthesis' in window)) return;

    try {
      // 既存の発話をキャンセルして即時発話
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      utterance.rate = 1.15; // 小学生向けに少しテンポよく
      utterance.pitch = 1.1;  // 親しみやすく明るい高めのピッチ

      // 日本語の自然な音声を優先選択
      const voices = window.speechSynthesis.getVoices();
      const jaVoice = voices.find(v => v.lang.startsWith('ja') && (v.name.includes('Otoya') || v.name.includes('Nanami') || v.name.includes('Google') || v.name.includes('Kyoko')));
      if (jaVoice) {
        utterance.voice = jaVoice;
      }

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('Speech synthesis error:', e);
    }
  }
};

window.AppAudio = AppAudio;
