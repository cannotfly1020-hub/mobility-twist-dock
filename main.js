/**
 * 柔軟性・しなりドック - アプリケーションコントローラー (AppController)
 * 
 * 【主な改修点・追加仕様】
 * 1. 非日常ポーズ認証ホールド連動 (Tポーズ / 頭上○サイン)
 * 2. ゼロリセット（スタート合図の瞬間の姿勢角度をθ_baseとして記憶し、相対変化量を測定）
 * 3. 生体追従ピークキープタイマー（動き出し検知 ➔ 最大角探索 ➔ 1.0秒キープで即ホイッスル確定）
 * 4. 左右完全インターロック進行（左側完了後は勝手に進まず、右側の認証ポーズ静止まで待機）
 * 5. 動的サビ取りドリル ＆ 個人カルテ管理 ＆ 完全省電力スリープ
 */
const App = {
  // アプリケーション状態
  state: {
    // 進行モード:
    // 'idle': 待機中（ポーズ認証受付）
    // 'counting_down': 3,2,1カウントダウン中
    // 'waiting_movement': スタート後の動き出し待機
    // 'measuring_peak': 身体を動かしてピーク角を探索中
    // 'peaking_hold': 最大角付近でキープ中（1秒維持で確定）
    // 'waiting_next_side': 左側完了後、右側の準備待ち（インターロック）
    // 'drill': 動的ストレッチ実施中
    mode: 'idle',

    currentTestType: 'thoracic', // 'thoracic' | 'hip' | 'hinge'
    currentSide: 'left', // 'left' | 'right'
    activePlayerId: null,

    // スリープ管理
    isSleeping: false,
    sleepTimerId: null,
    sleepTimeoutMs: 120000, // 2分放置でスリープ

    // 角度測定データ
    peakAngles: { left: 0, right: 0 },
    currentAngles: { main: 0, sub: 0 },
    currentRelativeAngle: 0,

    // タイマー・追従制御
    countdownTimer: null,
    motionWaitStartTime: null, // 動き出し監視開始時刻
    peakingStartTime: null,    // ピーク維持開始時刻
    measureMaxTimeoutId: null, // 8秒安全強制終了タイマー
    trackedPeakAngle: 0,

    // 動的ドリル状態
    drill: {
      isActive: false,
      intervalId: null,
      targetAngle: 30,
      combo: 0,
      reps: 0,
      maxReps: 10,
      lastBeatSide: 'left'
    }
  },

  STORAGE_KEYS: {
    PLAYERS: 'mobility_players_v1',
    RECORDS: 'mobility_records_v1'
  },

  TEST_CONFIG: {
    thoracic: {
      title: '胸パカーン（胸椎回旋）',
      icon: '🏹',
      guide: 'イスや正座でお辞儀。両手を広げてTポーズか頭上○でスタート！',
      targetThreshold: 45
    },
    hip: {
      title: '股関節ワイパー（回旋可動）',
      icon: '🦊',
      guide: 'イスに座り膝90度。Tポーズか頭上○を作ってスタート！',
      targetThreshold: 35
    },
    hinge: {
      title: 'もも裏前屈（ヒップヒンジ）',
      icon: '📐',
      guide: '背筋を伸ばしてイス浅座り。Tポーズか頭上○でスタート！',
      targetThreshold: 65
    }
  },

  dom: {},

  init() {
    this.cacheDom();
    this.bindEvents();
    this.initPlayers();
    this.initEngine();
    this.updateTestTypeUi();
  },

  cacheDom() {
    this.dom = {
      btnSwitchCamera: document.getElementById('btn-switch-camera'),
      btnOpenCarte: document.getElementById('btn-open-carte'),
      btnPlayerSelect: document.getElementById('btn-player-select'),
      headerPlayerName: document.getElementById('header-player-name'),
      btnDiffBadge: document.getElementById('btn-diff-badge'),
      headerDiffVal: document.getElementById('header-diff-val'),
      tabThoracic: document.getElementById('tab-thoracic'),
      tabHip: document.getElementById('tab-hip'),
      tabHinge: document.getElementById('tab-hinge'),

      guidanceBanner: document.getElementById('guidance-banner'),
      guideIcon: document.getElementById('guide-icon'),
      guideTitle: document.getElementById('guide-title'),
      guideDesc: document.getElementById('guide-desc'),
      poseTriggerBadge: document.getElementById('pose-trigger-badge'),
      triggerDot: document.getElementById('trigger-dot'),
      triggerText: document.getElementById('trigger-text'),

      webcamVideo: document.getElementById('webcam-video'),
      outputCanvas: document.getElementById('output-canvas'),
      safeBoundary: document.getElementById('safe-boundary'),
      metricMainVal: document.getElementById('metric-main-val'),
      metricSubVal: document.getElementById('metric-sub-val'),
      countdownBox: document.getElementById('countdown-box'),
      countdownNum: document.getElementById('countdown-num'),
      countdownGuide: document.getElementById('countdown-guide'),
      measuringBadge: document.getElementById('measuring-badge'),
      cheatAlertBadge: document.getElementById('cheat-alert-badge'),
      cheatAlertText: document.getElementById('cheat-alert-text'),

      drillHud: document.getElementById('drill-hud'),
      drillComboCounter: document.getElementById('drill-combo-counter'),
      drillProgressCount: document.getElementById('drill-progress-count'),
      drillStatusText: document.getElementById('drill-status-text'),

      btnStartTrigger: document.getElementById('btn-start-trigger'),
      btnOpenReport: document.getElementById('btn-open-report'),
      btnOpenDynamicDrill: document.getElementById('btn-open-dynamic-drill'),

      playerModal: document.getElementById('player-modal'),
      playerSelectDropdown: document.getElementById('player-select-dropdown'),
      formNewPlayer: document.getElementById('form-new-player'),
      inputPlayerName: document.getElementById('input-player-name'),
      inputPlayerDominant: document.getElementById('input-player-dominant'),
      inputPlayerGrade: document.getElementById('input-player-grade'),

      reportModal: document.getElementById('report-modal'),
      reportScoreGrade: document.getElementById('report-score-grade'),
      reportComment: document.getElementById('report-comment'),
      reportLeftVal: document.getElementById('report-left-val'),
      reportRightVal: document.getElementById('report-right-val'),
      barLeft: document.getElementById('bar-left'),
      barRight: document.getElementById('bar-right'),
      btnSaveReport: document.getElementById('btn-save-report'),
      btnReportStartDrill: document.getElementById('btn-report-start-drill'),

      carteModal: document.getElementById('carte-modal'),
      carteListContainer: document.getElementById('carte-list-container'),
      btnExportCsv: document.getElementById('btn-export-csv'),
      btnShareLine: document.getElementById('btn-share-line'),
      sleepOverlay: document.getElementById('sleep-overlay'),
      toastBox: document.getElementById('toast-box'),
      modalCloseButtons: document.querySelectorAll('.modal-close')
    };
  },

  bindEvents() {
    this.dom.btnSwitchCamera.addEventListener('click', async () => {
      try {
        await window.AppEngine.switchCamera();
        this.showToast('カメラを切り替えました');
      } catch (err) {
        this.showToast('カメラ切り替えに失敗しました');
      }
    });

    this.dom.tabThoracic.addEventListener('click', () => this.switchTestType('thoracic'));
    this.dom.tabHip.addEventListener('click', () => this.switchTestType('hip'));
    this.dom.tabHinge.addEventListener('click', () => this.switchTestType('hinge'));

    this.dom.btnStartTrigger.addEventListener('click', () => {
      window.AppAudio.init();
      if (this.state.mode === 'idle' || this.state.mode === 'waiting_next_side') {
        this.startCountdown(this.state.currentSide);
      } else if (this.state.mode === 'drill') {
        this.stopDynamicDrill();
      }
    });

    this.dom.btnPlayerSelect.addEventListener('click', () => this.openPlayerModal());
    this.dom.btnOpenCarte.addEventListener('click', () => this.openCarteModal());
    this.dom.btnOpenReport.addEventListener('click', () => this.openReportModal());
    this.dom.btnOpenDynamicDrill.addEventListener('click', () => this.startDynamicDrill());

    this.dom.playerSelectDropdown.addEventListener('change', (e) => this.selectPlayer(e.target.value));
    this.dom.formNewPlayer.addEventListener('submit', (e) => this.handleSaveNewPlayer(e));

    this.dom.btnSaveReport.addEventListener('click', () => this.saveCurrentTestRecord());
    this.dom.btnReportStartDrill.addEventListener('click', () => {
      this.closeModals();
      this.startDynamicDrill();
    });

    this.dom.btnExportCsv.addEventListener('click', () => this.exportCarteCsv());
    this.dom.btnShareLine.addEventListener('click', () => this.shareToLine());

    this.dom.modalCloseButtons.forEach((btn) => {
      btn.addEventListener('click', () => this.closeModals());
    });

    if (this.dom.sleepOverlay) {
      this.dom.sleepOverlay.addEventListener('click', () => this.wakeUpFromSleep());
    }

    ['touchstart', 'mousedown', 'keydown'].forEach(evt => {
      window.addEventListener(evt, () => this.resetSleepTimer(), { passive: true });
    });
    this.resetSleepTimer();
  },

  resetSleepTimer() {
    if (this.state.isSleeping) return;
    if (this.state.sleepTimerId) clearTimeout(this.state.sleepTimerId);
    this.state.sleepTimerId = setTimeout(() => {
      if (this.state.mode === 'idle' || this.state.mode === 'waiting_next_side') {
        this.enterSleepMode();
      } else {
        this.resetSleepTimer();
      }
    }, this.state.sleepTimeoutMs);
  },

  enterSleepMode() {
    this.state.isSleeping = true;
    if (this.dom.sleepOverlay) {
      this.dom.sleepOverlay.classList.remove('hidden');
    }
    if (window.AppEngine && window.AppEngine.pause) {
      window.AppEngine.pause();
    }
  },

  wakeUpFromSleep() {
    this.state.isSleeping = false;
    if (this.dom.sleepOverlay) {
      this.dom.sleepOverlay.classList.add('hidden');
    }
    if (window.AppEngine && window.AppEngine.resume) {
      window.AppEngine.resume();
    }
    this.resetSleepTimer();
    this.showToast('スリープから復帰しました');
  },

  async initEngine() {
    try {
      await window.AppEngine.init({
        video: this.dom.webcamVideo,
        canvas: this.dom.outputCanvas
      });

      window.AppEngine.onFrameUpdate = this.handleFrameUpdate.bind(this);
      window.AppEngine.onError = (err) => {
        console.error('Engine error:', err);
        this.showToast('カメラエラー。権限を確認してください。');
      };

      await window.AppEngine.startCamera();
      this.showToast('スマート測定エンジンが起動しました！');
    } catch (e) {
      console.warn('Init engine error:', e);
      this.showToast('カメラアクセスを許可してください');
    }
  },

  /**
   * 毎フレーム解析処理（生体追従・アダプティブタイマー連動）
   */
  handleFrameUpdate(data) {
    if (!data.detected) {
      this.updatePoseBadge(false, '全身をカメラに映してね', 0);
      return;
    }

    const {
      isReady,
      authProgress,
      poseMessage,
      isStationary,
      rawAngles,
      relativeAngle,
      cheatDetected,
      cheatReason
    } = data;

    // 1. リアルタイム角度表示（ゼロリセット適用後の相対角を表示）
    this.state.currentAngles = rawAngles;
    this.state.currentRelativeAngle = relativeAngle;

    if (this.state.mode === 'waiting_movement' || this.state.mode === 'measuring_peak' || this.state.mode === 'peaking_hold') {
      // 測定中はゼロリセット後の相対変化量を大きく表示
      this.dom.metricMainVal.textContent = `${relativeAngle}°`;
      this.dom.metricSubVal.textContent = `生: ${rawAngles.currentAngle}°`;
    } else {
      this.dom.metricMainVal.textContent = `${rawAngles.main || 0}°`;
      this.dom.metricSubVal.textContent = `${rawAngles.sub || 0}°`;
    }

    // 2. カンニング（お尻浮き）の警告
    if (cheatDetected && (this.state.mode === 'measuring_peak' || this.state.mode === 'peaking_hold')) {
      this.dom.cheatAlertBadge.classList.remove('hidden');
      this.dom.cheatAlertText.textContent = cheatReason || 'お尻が浮いています！';
    } else {
      this.dom.cheatAlertBadge.classList.add('hidden');
    }

    // 3. 待機時または反対側待機時：非日常ポーズ認証＆完全静止の監視
    if (this.state.mode === 'idle' || this.state.mode === 'waiting_next_side') {
      this.updatePoseBadge(isReady, poseMessage, authProgress, isStationary);

      if (isReady) {
        // 1.5秒キープ達成 ➔ スタート合図
        window.AppAudio.playLockSound();
        this.startCountdown(this.state.currentSide);
      }
    }

    // 4. 生体追従ピークタイマー処理
    if (this.state.mode === 'waiting_movement') {
      // 動き出し待機フェーズ（相対角が8度を超えたら回旋開始とみなす）
      if (relativeAngle >= 8) {
        this.state.mode = 'measuring_peak';
        this.dom.measuringBadge.classList.remove('hidden');
        this.dom.measuringBadge.innerHTML = '<span>⚡</span><span>測定中（ピーク探索）</span>';
        window.AppAudio.speak('いいぞ、そのまま限界までキープ！');
      } else {
        // 動き出さないまま6秒経過したらタイムアウト
        if (performance.now() - this.state.motionWaitStartTime > 6000) {
          this.finishSingleSide(this.state.currentSide, 0);
        }
      }
    } else if (this.state.mode === 'measuring_peak' || this.state.mode === 'peaking_hold') {
      this.processAdaptivePeakTracking(relativeAngle, isStationary);
    }

    // 5. 動的ドリルモード
    if (this.state.mode === 'drill' && this.state.drill.isActive) {
      this.handleDrillFrame(rawAngles);
    }
  },

  /**
   * 生体追従ピークキープ判定
   * 角度が伸びている間は測定継続、最大角付近で1秒ピタッと静止したら即完了ホイッスル
   */
  processAdaptivePeakTracking(currentRelAngle, isStationary) {
    const side = this.state.currentSide;
    const now = performance.now();

    // 最大角の更新
    if (currentRelAngle > this.state.trackedPeakAngle) {
      this.state.trackedPeakAngle = currentRelAngle;
      this.state.peakAngles[side] = currentRelAngle;
      // ピーク更新中はキープタイマーをリセット
      this.state.peakingStartTime = null;
      this.state.mode = 'measuring_peak';
    } else if (currentRelAngle >= (this.state.trackedPeakAngle - 3) && isStationary) {
      // 最大角付近（±3°以内）で静止している場合
      if (!this.state.peakingStartTime) {
        this.state.peakingStartTime = now;
        this.state.mode = 'peaking_hold';
        this.dom.measuringBadge.innerHTML = '<span>🎯</span><span>ナイス！1秒キープ！</span>';
      } else if (now - this.state.peakingStartTime >= 1000) {
        // ★ 1.0秒キープ達成！即座に正式記録として完了
        this.finishSingleSide(side, this.state.trackedPeakAngle);
      }
    }
  },

  /**
   * カウントダウン開始 (3, 2, 1)
   */
  startCountdown(side) {
    this.state.mode = 'counting_down';
    this.state.currentSide = side;

    const sideJa = side === 'left' ? 'ひだり' : 'みぎ';
    window.AppAudio.speak(`${sideJa}側の測定！準備してね`);

    this.dom.countdownBox.classList.remove('hidden');
    this.dom.countdownGuide.textContent = `${side === 'left' ? '左側' : '右側'}の姿勢！`;
    this.dom.btnStartTrigger.classList.add('opacity-50', 'pointer-events-none');

    let count = 3;
    this.dom.countdownNum.textContent = count;
    window.AppAudio.playTone(440, 'sine', 0.1);

    if (this.state.countdownTimer) clearInterval(this.state.countdownTimer);

    this.state.countdownTimer = setInterval(() => {
      count--;
      if (count > 0) {
        this.dom.countdownNum.textContent = count;
        window.AppAudio.playTone(440, 'sine', 0.1);
      } else {
        clearInterval(this.state.countdownTimer);
        this.dom.countdownBox.classList.add('hidden');
        this.triggerZeroResetAndStart(side);
      }
    }, 1000);
  },

  /**
   * ゼロリセット実行 ＆ 測定追従開始
   */
  triggerZeroResetAndStart(side) {
    // 【ゼロリセット】現在の構え角をθ_baseとしてエンジンに記憶
    const rawNow = this.state.currentAngles.currentAngle || 0;
    window.AppEngine.calibrateBaseAngle(rawNow);

    this.state.trackedPeakAngle = 0;
    this.state.motionWaitStartTime = performance.now();
    this.state.peakingStartTime = null;
    this.state.mode = 'waiting_movement';

    this.dom.measuringBadge.classList.remove('hidden');
    this.dom.measuringBadge.innerHTML = '<span>🏃</span><span>ゆっくり動かしてね</span>';
    window.AppAudio.speak('スタート！ひねってキープ！');

    // 安全遮断タイマー（8秒経ってもキープできなければその時点の最大値で終了）
    if (this.state.measureMaxTimeoutId) clearTimeout(this.state.measureMaxTimeoutId);
    this.state.measureMaxTimeoutId = setTimeout(() => {
      if (this.state.mode === 'measuring_peak' || this.state.mode === 'peaking_hold' || this.state.mode === 'waiting_movement') {
        this.finishSingleSide(side, this.state.trackedPeakAngle);
      }
    }, 8000);
  },

  /**
   * 片側の測定完了処理
   */
  finishSingleSide(side, finalVal) {
    if (this.state.measureMaxTimeoutId) {
      clearTimeout(this.state.measureMaxTimeoutId);
      this.state.measureMaxTimeoutId = null;
    }

    this.dom.measuringBadge.classList.add('hidden');
    this.dom.cheatAlertBadge.classList.add('hidden');
    window.AppEngine.resetBaseAngle(); // ゼロリセット解除

    window.AppAudio.playWhistle(); // ピピッ！
    window.AppAudio.speak(`ナイス！記録は${finalVal}度です。`);

    if (side === 'left') {
      // 【完全インターロック】勝手に右側を始めず、準備待機へ移行
      this.state.mode = 'waiting_next_side';
      this.state.currentSide = 'right';
      this.dom.btnStartTrigger.classList.remove('opacity-50', 'pointer-events-none');
      this.updateDiffDisplay();

      // 右側準備の音声案内
      setTimeout(() => {
        window.AppAudio.speak('次は右側だよ。反対を向いて、Tポーズか頭上マルを作ってね！');
        this.showToast('👉 次は右側！反対向きで認証ポーズを取ってね');
      }, 1500);
    } else {
      // 左右両方完了 ➔ レポート表示
      this.state.mode = 'idle';
      this.dom.btnStartTrigger.classList.remove('opacity-50', 'pointer-events-none');
      this.updateDiffDisplay();
      setTimeout(() => {
        this.openReportModal();
      }, 1200);
    }
  },

  /**
   * テスト種目の切り替え
   */
  switchTestType(type) {
    if (this.state.mode !== 'idle' && this.state.mode !== 'waiting_next_side') return;

    this.state.currentTestType = type;
    this.state.currentSide = 'left';
    this.state.mode = 'idle';
    window.AppEngine.currentTestType = type;
    window.AppEngine.resetCalibration();
    this.updateTestTypeUi();

    const config = this.TEST_CONFIG[type];
    window.AppAudio.speak(`${config.title}に切り替えました。${config.guide}`);
  },

  updateTestTypeUi() {
    const type = this.state.currentTestType;
    const config = this.TEST_CONFIG[type];

    [this.dom.tabThoracic, this.dom.tabHip, this.dom.tabHinge].forEach(el => {
      el.classList.remove('active-tab', 'bg-indigo-700', 'border-indigo-950');
      el.classList.add('bg-slate-800', 'border-slate-950', 'opacity-80');
    });

    const activeTab = type === 'thoracic' ? this.dom.tabThoracic :
                      type === 'hip' ? this.dom.tabHip : this.dom.tabHinge;
    activeTab.classList.add('active-tab', 'bg-indigo-700', 'border-indigo-950');
    activeTab.classList.remove('opacity-80');

    this.dom.guideIcon.textContent = config.icon;
    this.dom.guideTitle.textContent = config.title;
    this.dom.guideDesc.textContent = config.guide;

    this.state.peakAngles = { left: 0, right: 0 };
    this.updateDiffDisplay();
  },

  /**
   * 動的ストレッチ（音ゲー風ドリル）
   */
  startDynamicDrill() {
    if (this.state.drill.isActive) return;

    this.state.mode = 'drill';
    this.state.drill.isActive = true;
    this.state.drill.combo = 0;
    this.state.drill.reps = 0;
    this.state.drill.targetAngle = Math.max(25, Math.round(this.state.peakAngles.left * 0.7) || 30);

    this.dom.drillHud.classList.remove('hidden');
    this.dom.drillComboCounter.textContent = '0';
    this.dom.drillProgressCount.textContent = `0 / ${this.state.drill.maxReps}`;
    this.dom.drillStatusText.textContent = `目標: テンポよく左右${this.state.drill.targetAngle}度！`;
    this.dom.btnStartTrigger.innerHTML = '<span>⏹️</span><span>ドリル終了</span>';

    window.AppAudio.speak('動的ストレッチスタート！リズムに合わせて大きく動かそう！');

    if (this.state.drill.intervalId) clearInterval(this.state.drill.intervalId);
    this.state.drill.intervalId = setInterval(() => {
      window.AppAudio.playTone(330, 'sine', 0.04, 0, 0.08);
    }, 500);
  },

  handleDrillFrame(angles) {
    const drill = this.state.drill;
    const currentActive = angles.activeSide || 'left';
    const angleVal = angles.currentAngle || angles.main || 0;

    if (angleVal >= drill.targetAngle && currentActive !== drill.lastBeatSide) {
      drill.lastBeatSide = currentActive;
      drill.reps++;
      drill.combo++;

      window.AppAudio.playComboPing(drill.combo);
      this.dom.drillComboCounter.textContent = drill.combo;
      this.dom.drillProgressCount.textContent = `${drill.reps} / ${drill.maxReps}`;

      if (drill.reps >= drill.maxReps) {
        this.finishDynamicDrill();
      }
    }
  },

  finishDynamicDrill() {
    this.stopDynamicDrill();
    window.AppAudio.playFanfare();
    window.AppAudio.speak('ドリル制覇！筋肉のサビが取れて可動域が覚醒しました！');
    this.showToast('🎉 10往復ドリル完全制覇！');
  },

  stopDynamicDrill() {
    this.state.drill.isActive = false;
    this.state.mode = 'idle';
    if (this.state.drill.intervalId) {
      clearInterval(this.state.drill.intervalId);
      this.state.drill.intervalId = null;
    }
    this.dom.drillHud.classList.add('hidden');
    this.dom.btnStartTrigger.innerHTML = '<span>🚀</span><span>測定スタート</span>';
  },

  initPlayers() {
    const players = this.getStoredPlayers();
    if (players.length === 0) {
      const defaultPlayer = {
        id: 'player_' + Date.now(),
        name: 'タイガ',
        grade: '小学5年生',
        height: 140,
        dominant: 'right',
        batSide: 'right'
      };
      this.savePlayers([defaultPlayer]);
      this.state.activePlayerId = defaultPlayer.id;
    } else {
      this.state.activePlayerId = players[0].id;
    }
    this.refreshPlayerUi();
  },

  getStoredPlayers() {
    try {
      return JSON.parse(localStorage.getItem(this.STORAGE_KEYS.PLAYERS)) || [];
    } catch {
      return [];
    }
  },

  savePlayers(players) {
    localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(players));
  },

  getActivePlayer() {
    const players = this.getStoredPlayers();
    return players.find(p => p.id === this.state.activePlayerId) || players[0];
  },

  selectPlayer(playerId) {
    if (!playerId) return;
    this.state.activePlayerId = playerId;
    this.refreshPlayerUi();
    this.closeModals();
    this.showToast('選手を切り替えました');
  },

  handleSaveNewPlayer(e) {
    e.preventDefault();
    const name = this.dom.inputPlayerName.value.trim();
    if (!name) return;

    const newPlayer = {
      id: 'player_' + Date.now(),
      name: name,
      dominant: this.dom.inputPlayerDominant.value,
      grade: this.dom.inputPlayerGrade.value,
      batSide: this.dom.inputPlayerDominant.value
    };

    const players = this.getStoredPlayers();
    players.push(newPlayer);
    this.savePlayers(players);

    this.state.activePlayerId = newPlayer.id;
    this.refreshPlayerUi();
    this.dom.formNewPlayer.reset();
    this.closeModals();
    this.showToast(`選手「${name}」を登録しました`);
  },

  refreshPlayerUi() {
    const player = this.getActivePlayer();
    if (!player) return;

    this.dom.headerPlayerName.textContent = player.name;

    const players = this.getStoredPlayers();
    this.dom.playerSelectDropdown.innerHTML = '<option value="">-- 選手を選択してください --</option>' +
      players.map(p => `<option value="${p.id}" ${p.id === player.id ? 'selected' : ''}>${p.name} (${p.grade}・${p.dominant === 'right' ? '右投' : '左投'})</option>`).join('');
  },

  openReportModal() {
    const left = this.state.peakAngles.left;
    const right = this.state.peakAngles.right;
    const diff = Math.abs(left - right);
    const total = (left + right) || 1;

    let grade = 'B';
    let comment = '良好なしなり！左右差をなくそう！';

    if (left >= 45 && right >= 45 && diff <= 5) {
      grade = 'S';
      comment = '超一流プロ級！神レベルのしなりと均整バランス！';
    } else if (left >= 35 && right >= 35 && diff <= 10) {
      grade = 'A';
      comment = '素晴らしい柔軟性！球速UPの準備完了！';
    } else if (diff > 15) {
      grade = 'C';
      comment = `左右差が${diff}°あります。硬い方を重点ドリルしよう！`;
    }

    this.dom.reportScoreGrade.textContent = grade;
    this.dom.reportComment.textContent = comment;
    this.dom.reportLeftVal.textContent = `${left}°`;
    this.dom.reportRightVal.textContent = `${right}°`;

    const leftRatio = Math.round((left / total) * 100);
    const rightRatio = 100 - leftRatio;
    this.dom.barLeft.style.width = `${leftRatio}%`;
    this.dom.barRight.style.width = `${rightRatio}%`;

    this.dom.reportModal.classList.remove('hidden');
    window.AppAudio.speak(`測定完了！総合しなりランクは${grade}です！`);
  },

  saveCurrentTestRecord() {
    const player = this.getActivePlayer();
    const left = this.state.peakAngles.left;
    const right = this.state.peakAngles.right;
    const diff = Math.abs(left - right);

    const record = {
      id: 'rec_' + Date.now(),
      playerId: player.id,
      playerName: player.name,
      testType: this.state.currentTestType,
      testName: this.TEST_CONFIG[this.state.currentTestType].title,
      left: left,
      right: right,
      diff: diff,
      grade: this.dom.reportScoreGrade.textContent,
      timestamp: new Date().toISOString()
    };

    const records = this.getStoredRecords();
    records.unshift(record);
    localStorage.setItem(this.STORAGE_KEYS.RECORDS, JSON.stringify(records));

    this.showToast('カルテに保存しました！');
    this.closeModals();
  },

  getStoredRecords() {
    try {
      return JSON.parse(localStorage.getItem(this.STORAGE_KEYS.RECORDS)) || [];
    } catch {
      return [];
    }
  },

  openCarteModal() {
    this.renderCarteList();
    this.dom.carteModal.classList.remove('hidden');
  },

  renderCarteList() {
    const records = this.getStoredRecords();
    const container = this.dom.carteListContainer;

    if (records.length === 0) {
      container.innerHTML = '<div class="text-center text-slate-400 text-xs py-8">測定履歴がまだありません</div>';
      return;
    }

    container.innerHTML = records.map(r => {
      const dateStr = new Date(r.timestamp).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `
        <div class="bg-slate-800/90 border border-slate-700 rounded-xl p-2.5 flex flex-col gap-1 shadow">
          <div class="flex justify-between items-center text-xs">
            <span class="font-black text-yellow-300">${r.playerName} - ${r.testName}</span>
            <span class="text-[10px] text-slate-400">${dateStr}</span>
          </div>
          <div class="flex justify-between items-center mt-1">
            <div class="text-xs font-bold">
              <span class="text-cyan-400">左: ${r.left}°</span> / 
              <span class="text-pink-400">右: ${r.right}°</span>
              <span class="text-[10px] text-amber-300 ml-1.5">(差: ${r.diff}°)</span>
            </div>
            <span class="px-2 py-0.5 bg-indigo-900 border border-indigo-400 text-yellow-300 font-black rounded-lg text-xs">
              ランク ${r.grade}
            </span>
          </div>
        </div>
      `;
    }).join('');
  },

  exportCarteCsv() {
    const records = this.getStoredRecords();
    if (records.length === 0) {
      this.showToast('出力するデータがありません');
      return;
    }

    const headers = ['日時', '選手名', 'テスト名', '左角度', '右角度', '左右差', '評価ランク'];
    const rows = records.map(r => [
      new Date(r.timestamp).toLocaleString('ja-JP'),
      `"${r.playerName}"`,
      `"${r.testName}"`,
      r.left,
      r.right,
      r.diff,
      r.grade
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `しなりドックカルテ_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.showToast('CSVファイルを保存しました');
  },

  shareToLine() {
    const player = this.getActivePlayer();
    const left = this.state.peakAngles.left;
    const right = this.state.peakAngles.right;
    const diff = Math.abs(left - right);
    const testName = this.TEST_CONFIG[this.state.currentTestType].title;

    const message = `【柔軟性・しなりドック 測定結果】\n選手: ${player.name}\n種目: ${testName}\n左: ${left}° / 右: ${right}° (左右差: ${diff}°)\n可動域を鍛えてパフォーマンスUP！`;
    const lineUrl = `https://line.me/R/msg/text/?${encodeURIComponent(message)}`;
    window.open(lineUrl, '_blank');
  },

  openPlayerModal() {
    this.dom.playerModal.classList.remove('hidden');
  },

  closeModals() {
    this.dom.playerModal.classList.add('hidden');
    this.dom.reportModal.classList.add('hidden');
    this.dom.carteModal.classList.add('hidden');
  },

  updateDiffDisplay() {
    const diff = Math.abs(this.state.peakAngles.left - this.state.peakAngles.right);
    this.dom.headerDiffVal.textContent = (this.state.peakAngles.left && this.state.peakAngles.right) ? `${diff}°` : '--°';
  },

  /**
   * 構え・認証バッジのUI更新
   */
  updatePoseBadge(isReady, message, progress = 0, isStationary = false) {
    if (this.state.mode === 'waiting_next_side') {
      this.dom.triggerDot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
      this.dom.triggerText.textContent = '反対側のポーズで静止！';
      this.dom.triggerText.className = 'text-[11px] font-bold text-amber-300';
      return;
    }

    if (isReady) {
      this.dom.triggerDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
      this.dom.triggerText.textContent = '認証完了！スタート！';
      this.dom.triggerText.className = 'text-[11px] font-bold text-emerald-300';
    } else if (progress > 0) {
      const pct = Math.round(progress * 100);
      this.dom.triggerDot.className = 'w-2 h-2 rounded-full bg-yellow-400 animate-ping';
      this.dom.triggerText.textContent = `ポーズキープ中 (${pct}%)`;
      this.dom.triggerText.className = 'text-[11px] font-bold text-yellow-300';
    } else {
      this.dom.triggerDot.className = 'w-2 h-2 rounded-full bg-cyan-400';
      this.dom.triggerText.textContent = message || 'Tポーズまたは頭上○サイン';
      this.dom.triggerText.className = 'text-[11px] font-bold text-cyan-200';
    }
  },

  showToast(message) {
    const toast = this.dom.toastBox;
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('opacity-0', 'translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');

    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-4');
      toast.classList.remove('opacity-100', 'translate-y-0');
    }, 2400);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

window.App = App;
