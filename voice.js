// voice.js - フルボイス制御モジュール
export class VoiceManager {
    constructor() {
        this.synth = window.speechSynthesis;
        this.voice = null;
        this._initVoice();
    }

    _initVoice() {
        const setVoice = () => {
            const voices = this.synth.getVoices();
            // 日本語の音声を優先して取得
            this.voice = voices.find(v => v.lang === 'ja-JP') || voices[0];
        };
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = setVoice;
        }
        setVoice();
    }

    speak(text, pitch = 1.2, rate = 1.2) {
        if (this.synth.speaking) {
            this.synth.cancel();
        }
        const utterance = new SpeechSynthesisUtterance(text);
        if (this.voice) utterance.voice = this.voice;
        utterance.pitch = pitch;
        utterance.rate = rate; // 少し早口でエネルギッシュに
        this.synth.speak(utterance);
    }

    playStart() {
        this.speak("測定開始！腰を回さず、胸を回せ！");
    }

    playResult(rank) {
        let comment = "";
        if (rank.includes("SUPER DRAGON")) comment = "完璧なスーパードラゴン！";
        else if (rank.includes("LEVEL 2")) comment = "レベル2！実戦しなりマスター！";
        else if (rank.includes("あと少し")) comment = "あと少しで覚醒じゃ！";
        else comment = "カチコチ要解除！ドリルで油を差そう！";
        
        this.speak(`結果発表！${comment}`);
    }

    playDrillStart() {
        this.speak("1分間動的サビ取りドリル、スタート！限界まで胸を開け！");
    }
}
