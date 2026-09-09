// main.js - アプリケーション制御
import { VoiceManager } from './voice.js';
import { BiomechanicsCalc } from './biomechanics.js';

class AppController {
    constructor() {
        this.voice = new VoiceManager();
        this.calc = new BiomechanicsCalc();
        this.screens = {
            home: document.getElementById('screen-home'),
            measure: document.getElementById('screen-measure'),
            result: document.getElementById('screen-result'),
            drill: document.getElementById('screen-drill')
        };
        this.drillTimerId = null;
        this.bindEvents();
    }

    switchScreen(screenName) {
        Object.values(this.screens).forEach(screen => {
            screen.classList.add('hidden');
            screen.classList.remove('active');
        });
        this.screens[screenName].classList.remove('hidden');
        this.screens[screenName].classList.add('active');
    }

    bindEvents() {
        document.getElementById('btn-start').addEventListener('click', () => this.startMeasurement());
        document.getElementById('btn-cancel').addEventListener('click', () => this.switchScreen('home'));
        document.getElementById('btn-drill').addEventListener('click', () => this.startDrill());
        document.getElementById('btn-finish-drill').addEventListener('click', () => this.finishDrill());
    }

    startMeasurement() {
        this.switchScreen('measure');
        this.voice.playStart();
        const progressBar = document.getElementById('measure-progress');
        progressBar.style.width = '0%';

        this.calc.simulateMeasurement(
            (progress) => {
                progressBar.style.width = `${progress}%`;
            },
            (result) => {
                this.showResult(result);
            }
        );
    }

    showResult(result) {
        this.switchScreen('result');
        document.getElementById('rank-display').textContent = result.rank;
        document.getElementById('val-thoracic').textContent = result.thoracicAngle;
        document.getElementById('val-hip').textContent = result.hipSeparation;
        document.getElementById('feedback-message').textContent = result.feedback;
        
        this.voice.playResult(result.rank);
    }

    startDrill() {
        this.switchScreen('drill');
        this.voice.playDrillStart();
        
        let timeLeft = 60;
        const timeDisplay = document.getElementById('drill-time');
        timeDisplay.textContent = timeLeft;

        if (this.drillTimerId) clearInterval(this.drillTimerId);
        
        this.drillTimerId = setInterval(() => {
            timeLeft--;
            timeDisplay.textContent = timeLeft;
            
            // 残り時間に応じたボイス応援
            if (timeLeft === 30) this.voice.speak("残り半分！肩甲骨を寄せるんじゃ！");
            if (timeLeft === 10) this.voice.speak("ラスト10秒！限界突破！");
            
            if (timeLeft <= 0) {
                clearInterval(this.drillTimerId);
                this.finishDrill();
            }
        }, 1000);
    }

    finishDrill() {
        if (this.drillTimerId) clearInterval(this.drillTimerId);
        this.voice.speak("ドリル完了！さあ、どれくらいしなるようになったか再測定じゃ！");
        this.startMeasurement(); // 成功体験ループへ戻る
    }
}

// DOM読み込み完了後にアプリ起動
document.addEventListener('DOMContentLoaded', () => {
    new AppController();
});
