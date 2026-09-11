class App {
    constructor() {
        this.engine = window.poseEngine;
        this.audio = window.audioApp;
        
        // DOM Elements
        this.screens = {
            home: document.getElementById('screenHome'),
            menu: document.getElementById('screenMenu'),
            result: document.getElementById('screenResult'),
            drill: document.getElementById('screenDrill')
        };
        this.hud = {
            msg: document.getElementById('hudMessage'),
            angles: document.getElementById('hudAngles'),
            angleLeft: document.getElementById('angleLeft'),
            angleRight: document.getElementById('angleRight')
        };

        this.state = 'HOME';
        this.playerName = 'ゲスト';
        this.currentMode = null;
        
        // Measurement Logic
        this.readyTimer = 0;
        this.isMeasuring = false;
        this.maxValues = { left: 0, right: 0, ext: 0, int: 0 };
        this.lastWarningTime = 0;
        
        // Drill Logic
        this.drillInterval = null;
        this.drillCombo = 0;
        this.drillTargetCount = 0;
        this.isDrillActive = false;

        this.bindEvents();
    }

    bindEvents() {
        document.getElementById('btnStartApp').addEventListener('click', () => {
            const name = document.getElementById('inputPlayerName').value.trim();
            if (name) this.playerName = name;
            document.getElementById('headerPlayerName').classList.remove('hidden');
            document.getElementById('headerPlayerName').innerHTML = `<span class="text-amber-400">👤 ${this.playerName}</span>`;
            document.getElementById('btnExit').classList.remove('hidden');
            
            this.audio.init();
            this.audio.playTick();
            this.engine.startCamera();
            this.changeScreen('MENU');
        });

        document.getElementById('btnExit').addEventListener('click', () => {
            location.reload();
        });

        document.querySelectorAll('.brawl-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.audio.playTick();
                const mode = e.currentTarget.dataset.mode;
                this.startMeasurementSession(mode);
            });
        });

        document.getElementById('btnBackToMenu').addEventListener('click', () => {
            this.audio.playTick();
            this.engine.setMode(null, null);
            this.changeScreen('MENU');
        });

        document.getElementById('btnGoDrill').addEventListener('click', () => {
            this.audio.playTick();
            this.startDrill();
        });

        document.getElementById('btnCancelDrill').addEventListener('click', () => {
            this.audio.playTick();
            this.stopDrill();
            this.changeScreen('RESULT');
        });
    }

    changeScreen(state) {
        Object.values(this.screens).forEach(s => s.classList.add('hidden'));
        this.hud.angles.classList.add('hidden');
        this.hud.msg.parentElement.classList.add('hidden');
        document.getElementById('cameraContainer').classList.add('hidden');

        this.state = state;

        if (state === 'HOME') this.screens.home.classList.remove('hidden');
        if (state === 'MENU') {
            this.screens.menu.classList.remove('hidden');
            document.getElementById('cameraContainer').classList.remove('hidden');
        }
        if (state === 'MEASURE' || state === 'READY') {
            document.getElementById('cameraContainer').classList.remove('hidden');
            this.hud.angles.classList.remove('hidden');
            this.hud.msg.parentElement.classList.remove('hidden');
        }
        if (state === 'RESULT') {
            document.getElementById('cameraContainer').classList.remove('hidden');
            this.screens.result.classList.remove('hidden');
        }
        if (state === 'DRILL') {
            document.getElementById('cameraContainer').classList.remove('hidden');
            this.screens.drill.classList.remove('hidden');
        }
    }

    setHUDMessage(text, colorClass = 'text-white') {
        this.hud.msg.className = `bg-slate-900/80 border-2 border-slate-600 px-6 py-2 rounded-full font-black text-xl double-shadow transition-all duration-300 ${colorClass}`;
        this.hud.msg.innerText = text;
    }

    startMeasurementSession(mode) {
        this.currentMode = mode;
        this.isMeasuring = false;
        this.readyTimer = 0;
        this.maxValues = { left: 0, right: 0, ext: -999, int: 999 }; // int is min value
        
        this.changeScreen('READY');
        this.setHUDMessage("カメラを見て、構えろ！", "text-amber-400");
        this.engine.setMode(mode, this.onPoseUpdate.bind(this));
    }

    onPoseUpdate(data) {
        if (this.state !== 'READY' && this.state !== 'MEASURE' && this.state !== 'DRILL') return;

        if (data.state === 'NO_POSE') {
            if (this.state === 'READY') this.setHUDMessage("全身を画面に入れてね", "text-rose-400");
            return;
        }

        // --- Drill Mode ---
        if (this.state === 'DRILL') {
            this.handleDrillLogic(data.measurements);
            return;
        }

        // --- Measurement UI Updates ---
        const m = data.measurements;
        if (this.currentMode === 'hip' || this.currentMode === 'shoulder_flex') {
            this.hud.angleLeft.innerText = `${m.left}°`;
            this.hud.angleRight.innerText = `${m.right}°`;
        } else {
            // Lateral view
            this.hud.angleLeft.innerText = `${m.val}°`;
            this.hud.angleRight.innerText = `--°`;
            this.hud.angleLeft.previousElementSibling.innerText = m.activeSide;
            this.hud.angleRight.previousElementSibling.innerText = "";
        }

        // Warnings
        if (data.warning && Date.now() - this.lastWarningTime > 2000) {
            this.audio.playWarning();
            this.audio.speak(data.warning);
            this.lastWarningTime = Date.now();
        }

        // --- State Machine ---
        if (this.state === 'READY') {
            if (data.isReady) {
                this.readyTimer++;
                if (this.readyTimer === 1) this.setHUDMessage("キープ...", "text-emerald-400");
                
                // ~1秒キープ (約30fps想定)
                if (this.readyTimer > 25) {
                    this.startCountdown();
                }
            } else {
                this.readyTimer = 0;
                this.setHUDMessage("カメラを見て、構えろ！", "text-amber-400");
            }
        } 
        else if (this.state === 'MEASURE') {
            this.recordMaxValues(m);
        }
    }

    startCountdown() {
        this.state = 'COUNTDOWN';
        this.audio.playSuccess();
        let count = 3;
        
        const tick = () => {
            if (count > 0) {
                this.setHUDMessage(`${count}`, "text-amber-400 scale-150");
                this.audio.playBeep();
                count--;
                setTimeout(tick, 800);
            } else {
                this.setHUDMessage("GO! 動かして！", "text-emerald-400 scale-125");
                this.audio.playFanfare();
                this.state = 'MEASURE';
                this.isMeasuring = true;
                
                // 5秒間測定
                setTimeout(() => this.finishMeasurement(), 5000);
            }
        };
        tick();
    }

    recordMaxValues(m) {
        if (this.currentMode === 'hip' || this.currentMode === 'shoulder_flex') {
            this.maxValues.left = Math.max(this.maxValues.left, m.left);
            this.maxValues.right = Math.max(this.maxValues.right, m.right);
        } else if (this.currentMode === 'shoulder_gird') {
            this.maxValues.ext = Math.max(this.maxValues.ext, m.val); // 外旋は正の最大
            this.maxValues.int = Math.min(this.maxValues.int, m.val); // 内旋は負の最小(床方向)
        } else if (this.currentMode === 'hamstring') {
            this.maxValues.left = Math.max(this.maxValues.left, m.val); // 便宜上leftに格納
        }
    }

    finishMeasurement() {
        this.state = 'FINISHED';
        this.isMeasuring = false;
        this.audio.playTick();
        this.evaluateResult();
        this.changeScreen('RESULT');
    }

    evaluateResult() {
        const scoresDiv = document.getElementById('resultScores');
        const evalDiv = document.getElementById('resultEvaluation');
        const btnDrill = document.getElementById('btnGoDrill');
        
        let needsDrill = false;
        let html = '';
        let rank = '';
        let evalText = '';

        if (this.currentMode === 'hip') {
            const l = this.maxValues.left, r = this.maxValues.right;
            html = `<div class="text-2xl font-black">左: <span class="text-cyan-400">${l}°</span> / 右: <span class="text-rose-400">${r}°</span></div>`;
            const diff = Math.abs(l - r);
            if (l >= 45 && r >= 45 && diff <= 10) { rank = '🌟 SUPER DRAGON達成！'; evalText = 'プロ級の股関節！壁とタメは完璧だ！'; }
            else if (l >= 35 && r >= 35) { rank = '⚡ LEVEL 2'; evalText = '実戦で使えるしなり！'; needsDrill = true; }
            else { rank = '⚠️ カチコチ要解除'; evalText = '股関節が眠っているぞ！ドリルで解放しよう！'; needsDrill = true; }
        } 
        else if (this.currentMode === 'shoulder_flex') {
            const l = this.maxValues.left, r = this.maxValues.right;
            html = `<div class="text-2xl font-black">左: <span class="text-cyan-400">${l}°</span> / 右: <span class="text-rose-400">${r}°</span></div>`;
            if (l >= 160 && r >= 160) { rank = '🌟 SUPER DRAGON達成！'; evalText = '背中が完全に開いている！肘下がりゼロ！'; }
            else if (l >= 140 && r >= 140) { rank = '⚡ LEVEL 2'; evalText = '良い挙上だ！あと少しで覚醒！'; needsDrill = true; }
            else { rank = '⚠️ カチコチ要解除'; evalText = '広背筋が硬いぞ！サビ取りドリルへGO！'; needsDrill = true; }
        }
        else if (this.currentMode === 'shoulder_gird') {
            const ext = Math.max(0, this.maxValues.ext);
            const int = Math.abs(Math.min(0, this.maxValues.int)); // 内旋は負の値になっている想定
            const total = ext + int;
            html = `<div class="text-xl font-bold">外旋: <span class="text-cyan-400">${ext}°</span> / 内旋: <span class="text-rose-400">${int}°</span></div>
                    <div class="text-2xl font-black mt-2">Total Arc: <span class="text-amber-400">${total}°</span></div>`;
            if (total >= 150) { rank = '🌟 SUPER DRAGON達成！'; evalText = 'メジャー級の最大しなり！'; }
            else { rank = '🔒 あと少しで覚醒！'; evalText = '肩甲骨の動きを引き出そう！'; needsDrill = true; }
        }
        else if (this.currentMode === 'hamstring') {
            const val = this.maxValues.left;
            html = `<div class="text-2xl font-black">前傾: <span class="text-cyan-400">${val}°</span></div>`;
            if (val >= 60) { rank = '🌟 SUPER DRAGON達成！'; evalText = '完璧なヒンジ！腰痛知らずのフォームだ！'; }
            else if (val >= 40) { rank = '⚡ LEVEL 2'; evalText = '良い前傾だ！'; needsDrill = true; }
            else { rank = '⚠️ カチコチ要解除'; evalText = 'もも裏が硬い！ドリルで伸ばそう！'; needsDrill = true; }
        }

        scoresDiv.innerHTML = html;
        evalDiv.innerHTML = `<div class="text-2xl mb-2">${rank}</div><div class="text-sm text-slate-300 font-bold">${evalText}</div>`;
        
        if (needsDrill) {
            btnDrill.classList.remove('hidden');
            this.audio.speak(rank.replace(/[^\w\sぁ-んァ-ン一-龯]/g, '') + " ドリルでサビを落とそう");
        } else {
            btnDrill.classList.add('hidden');
            this.audio.speak("素晴らしい結果だ！スーパードラゴン達成！");
        }
    }

    // --- Dynamic Drill System ---
    startDrill() {
        this.changeScreen('DRILL');
        this.isDrillActive = true;
        this.drillCombo = 0;
        document.getElementById('drillCombo').innerText = "0";
        document.getElementById('ultGauge').style.width = "0%";
        
        if (this.currentMode === 'hip') {
            document.getElementById('drillTitle').innerText = "ワイパースイング";
            this.drillTargetCount = 20; // 左右往復
        } else if (this.currentMode === 'shoulder_flex') {
            document.getElementById('drillTitle').innerText = "W➔Y 羽ばたき";
            this.drillTargetCount = 15;
        } else {
            document.getElementById('drillTitle').innerText = "アクティブペダル";
            this.drillTargetCount = 10;
        }

        this.audio.speak("リズムに合わせて動かそう。スタート！");
        setTimeout(() => this.runDrillBeat(), 1500);
    }

    runDrillBeat() {
        if (!this.isDrillActive) return;

        // BPM 120 (500ms)
        this.drillInterval = setInterval(() => {
            this.audio.playBeep();
            
            // Visual beat indicator
            const beat = document.getElementById('beatIndicator');
            beat.classList.remove('animate-beat');
            void beat.offsetWidth; // trigger reflow
            beat.classList.add('animate-beat');
        }, 500);
    }

    handleDrillLogic(m) {
        if (!this.isDrillActive) return;
        
        // Simple logic: if movement exceeds a threshold, count a combo.
        // In reality, this requires tracking directional changes (peaks/valleys).
        // For simplicity, random chance tied to movement size to simulate logic.
        let trigger = false;
        if (this.currentMode === 'hip' && (m.left > 30 || m.right > 30)) trigger = true;
        if (this.currentMode === 'shoulder_flex' && (m.left > 130 && m.right > 130)) trigger = true;
        if ((this.currentMode === 'shoulder_gird' || this.currentMode === 'hamstring') && m.val > 30) trigger = true;

        // Throttle combos
        if (trigger && !this.drillLock) {
            this.drillLock = true;
            this.addDrillCombo();
            setTimeout(() => this.drillLock = false, 600); // Wait for next movement
        }
    }

    addDrillCombo() {
        this.drillCombo++;
        this.audio.playPerfect();
        
        const comboEl = document.getElementById('drillCombo');
        comboEl.innerText = this.drillCombo;
        comboEl.classList.add('scale-125', 'text-amber-300');
        setTimeout(() => comboEl.classList.remove('scale-125', 'text-amber-300'), 150);

        const progress = (this.drillCombo / this.drillTargetCount) * 100;
        
        // Update SVG circle dashoffset
        const circle = document.getElementById('drillProgress');
        const offset = 283 - (283 * progress) / 100;
        circle.style.strokeDashoffset = Math.max(0, offset);

        // Update ULT Gauge
        document.getElementById('ultGauge').style.width = `${Math.min(100, progress)}%`;

        if (this.drillCombo >= this.drillTargetCount) {
            this.finishDrill();
        }
    }

    finishDrill() {
        this.stopDrill();
        this.audio.playFanfare();
        this.setHUDMessage("ドリル完了！再テスト！", "text-emerald-400");
        this.audio.speak("サビが落ちたぞ！もう一度テストしよう！");
        
        setTimeout(() => {
            this.startMeasurementSession(this.currentMode);
        }, 3000);
    }

    stopDrill() {
        this.isDrillActive = false;
        clearInterval(this.drillInterval);
    }
}

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
