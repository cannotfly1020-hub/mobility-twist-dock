class AudioManager {
    constructor() {
        this.ctx = null;
        this.synth = window.speechSynthesis;
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
            
            // Dummy play to unlock audio on iOS
            const osc = this.ctx.createOscillator();
            osc.connect(this.ctx.destination);
            osc.start(0);
            osc.stop(0.001);

            this.initialized = true;
        } catch (e) {
            console.error("Audio API not supported", e);
        }
    }

    playTone(freq, type, duration, vol = 0.5) {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    }

    playBeep() {
        this.playTone(600, 'sine', 0.1, 0.3);
    }

    playTick() {
        this.playTone(800, 'square', 0.05, 0.1);
    }

    playSuccess() {
        if (!this.ctx) return;
        this.playTone(523.25, 'sine', 0.1, 0.5); // C5
        setTimeout(() => this.playTone(659.25, 'sine', 0.2, 0.5), 100); // E5
        setTimeout(() => this.playTone(783.99, 'sine', 0.4, 0.5), 200); // G5
    }

    playWarning() {
        this.playTone(300, 'sawtooth', 0.3, 0.5);
        setTimeout(() => this.playTone(250, 'sawtooth', 0.4, 0.5), 150);
    }

    playPerfect() {
        // Snare/Clap like sound + high pitch
        this.playTone(1200, 'square', 0.1, 0.2);
        if(!this.ctx) return;
        const noise = this.ctx.createBufferSource();
        const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.1, this.ctx.sampleRate);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < buffer.length; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        noise.buffer = buffer;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
        noise.connect(gain);
        gain.connect(this.ctx.destination);
        noise.start();
    }

    playFanfare() {
        const notes = [523.25, 523.25, 523.25, 659.25, 783.99, 1046.50];
        const times = [0, 0.15, 0.3, 0.45, 0.6, 0.9];
        notes.forEach((freq, i) => {
            setTimeout(() => this.playTone(freq, 'square', i === notes.length-1 ? 0.6 : 0.1, 0.4), times[i] * 1000);
        });
    }

    speak(text) {
        if (!this.synth) return;
        this.synth.cancel(); // Interrupt current speech
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ja-JP';
        utterance.rate = 1.2;
        this.synth.speak(utterance);
    }
}

window.audioApp = new AudioManager();
