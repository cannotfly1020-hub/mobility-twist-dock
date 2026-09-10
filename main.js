/**
 * 柔軟性・しなりドック - メインアプリケーションコントローラー
 * 状態管理、フルボイス進行シーケンス、動的ストレッチ、選手カルテ保存
 */
const App = {
  // アプリケーション状態
  state: {
    mode: 'idle', // 'idle' | 'waiting_ready' | 'counting_down' | 'measuring' | 'drill'
    currentTestType: 'thoracic', // 'thoracic' | 'hip' | 'hinge'
    currentSide: 'left', // 'left' | 'right'
    activePlayerId: null,

    // ピーク測定角度
    peakAngles: { left: 0, right: 0 },
    currentAngles: { main: 0, sub: 0 },

    // ジェスチャーホールドタイマー（1.0秒キープで自動トリガー）
    readyHoldStart: null,
    readyHoldRequired: 1000, // 1000ms

    // 計測カウントダウン・タイマー
    countdownTimer: null,
    measureTimer: null,
    measureDuration: 4000, // 4秒間

    // 動的ドリル状態
    drill: {
      isActive: false,
      intervalId: null,
      targetAngle: 30,
      combo: 0,
      reps: 0,
      maxReps: 10,
      lastBeatSide: 'left',
      beatDirection: 1 // 1 or -1
    }
  },

  // ストレージ定数キー
  STORAGE_KEYS: {
    PLAYERS: 'mobility_players_v1',
    RECORDS: 'mobility_records_v1'
  },

  // テスト別ガイダンス文言
  TEST_CONFIG: {
    thoracic: {
      title: '胸パカーン（胸椎回旋）',
      icon: '🦇',
      guide: '正座お辞儀から片手を頭に当て、天井へ胸を開こう！',
      targetThreshold: 45
    },
    hip: {
      title: '股関節ワイパー（回旋可動）',
      icon: '🦊',
      guide: 'イスに座り、膝を動かさずにすねを外/内へ振ろう！',
      targetThreshold: 35
    },
    hinge: {
      title: 'もも裏前屈（ヒップヒンジ）',
      icon: '📐',
      guide: '背中をまっすぐ伸ばしたまま、股関節から深く前屈！',
      targetThreshold: 60
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

  /**
   * DOM参照のキャッシュ
   */
  cacheDom() {
    this.dom = {
      // ヘッダー要素
      btnSwitchCamera: document.getElementById('btn-switch-camera'),
      btnOpenCarte: document.getElementById('btn-open-carte'),
      btnPlayerSelect: document.getElementById('btn-player-select'),
      headerPlayerName: document.getElementById('header-player-name'),
      btnDiffBadge: document.getElementById('btn-diff-badge'),
      headerDiffVal: document.getElementById('header-diff-val'),
      tabThoracic: document.getElementById('tab-thoracic'),
      tabHip: document.getElementById('tab-hip'),
      tabHinge: document.getElementById('tab-hinge'),

      // ガイダンス＆ステータス要素
      guidanceBanner: document.getElementById('guidance-banner'),
      guideIcon: document.getElementById('guide-icon'),
      guideTitle: document.getElementById('guide-title'),
      guideDesc: document.getElementById('guide-desc'),
      poseTriggerBadge: document.getElementById('pose-trigger-badge'),
      triggerDot: document.getElementById('trigger-dot'),
      triggerText: document.getElementById('trigger-text'),

      // カメラ＆キャンバス要素
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

      // ドリルHUD要素
      drillHud: document.getElementById('drill-hud'),
      drillComboCounter: document.getElementById('drill-combo-counter'),
      drillProgressCount: document.getElementById('drill-progress-count'),
      drillStatusText: document.getElementById('drill-status-text'),

      // 操作ボタン群
      btnStartTrigger: document.getElementById('btn-start-trigger'),
      btnOpenReport: document.getElementById('btn-open-report'),
      btnOpenDynamicDrill: document.getElementById('btn-open-dynamic-drill'),

      // モーダル要素群
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
      toastBox: document.getElementById('toast-box'),
      modalCloseButtons: document.querySelectorAll('.modal-close')
    };
  },

  bindEvents() {
    // カメラ切り替え
    this.dom.btnSwitchCamera.addEventListener('click', async () => {
      try {
        await window.AppEngine.switchCamera();
        this.showToast('カメラを切り替えました');
      } catch (err) {
        this.showToast('カメラ切り替えに失敗しました');
      }
    });

    // テスト切り替えタブ
    this.dom.tabThoracic.addEventListener('click', () => this.switchTestType('thoracic'));
    this.dom.tabHip.addEventListener('click', () => this.switchTestType('hip'));
    this.dom.tabHinge.addEventListener('click', () => this.switchTestType('hinge'));

    // 測定手動スタートボタン
    this.dom.btnStartTrigger.addEventListener('click', () => {
      window.AppAudio.init();
      if (this.state.mode === 'idle') {
        this.startMeasurementSequence('left');
      } else if (this.state.mode === 'drill') {
        this.stopDynamicDrill();
      }
    });

    // モーダルオープンボタン群
    this.dom.btnPlayerSelect.addEventListener('click', () => this.openPlayerModal());
    this.dom.btnOpenCarte.addEventListener('click', () => this.openCarteModal());
    this.dom.btnOpenReport.addEventListener('click', () => this.openReportModal());
    this.dom.btnOpenDynamicDrill.addEventListener('click', () => this.startDynamicDrill());

    // 選手選択・登録フォーム
    this.dom.playerSelectDropdown.addEventListener('change', (e) => this.selectPlayer(e.target.value));
    this.dom.formNewPlayer.addEventListener('submit', (e) => this.handleSaveNewPlayer(e));

    // レポートモーダル操作
    this.dom.btnSaveReport.addEventListener('click', () => this.saveCurrentTestRecord());
    this.dom.btnReportStartDrill.addEventListener('click', () => {
      this.closeModals();
      this.startDynamicDrill();
    });

    // カルテモーダル操作
    this.dom.btnExportCsv.addEventListener('click', () => this.exportCarteCsv());
    this.dom.btnShareLine.addEventListener('click', () => this.shareToLine());

    // 共通モーダルクローズ
    this.dom.modalCloseButtons.forEach((btn) => {
      btn.addEventListener('click', () => this.closeModals());
    });
  },

  async initEngine() {
    try {
      await window.AppEngine.init({
        video: this.dom.webcamVideo,
        canvas: this.dom.outputCanvas
      });

      // エンジンからの毎フレームコールバック
      window.AppEngine.onFrameUpdate = this.handleFrameUpdate.bind(this);
      window.AppEngine.onError = (err) => {
        console.error('Engine error:', err);
        this.showToast('カメラの起動に失敗しました。権限を確認してください。');
      };

      // 実機カメラ起動
      await window.AppEngine.startCamera();
      this.showToast('カメラとAI骨格認識が起動しました！');
    } catch (e) {
      console.warn('Init engine error:', e);
      this.showToast('カメラアクセスを許可してください');
    }
  },

  /**
   * 毎フレームの姿勢・角度・代償動作の評価処理
   */
  handleFrameUpdate(data) {
    if (!data.detected) {
      this.updatePoseBadge(false, '身体が映っていません');
      return;
    }

    const { angles, isReady, readyMessage, cheatDetected, cheatReason } = data;

    // 1. リアルタイム角度表示の更新
    this.state.currentAngles = angles;
    this.dom.metricMainVal.textContent = `${angles.main || 0}°`;
    this.dom.metricSubVal.textContent = `${angles.sub || 0}°`;

    // 2. カンニング（代償動作・お尻浮き）の警告制御
    if (cheatDetected && this.state.mode === 'measuring') {
      this.dom.cheatAlertBadge.classList.remove('hidden');
      this.dom.cheatAlertText.textContent = cheatReason || 'お尻が浮いています！';
    } else {
      this.dom.cheatAlertBadge.classList.add('hidden');
    }

    // 3. 待機中：顔・構えジェスチャーによる自動スタートトリガー判定
    if (this.state.mode === 'idle') {
      this.updatePoseBadge(isReady, readyMessage);

      if (isReady) {
        if (!this.state.readyHoldStart) {
          this.state.readyHoldStart = performance.now();
        } else if (performance.now() - this.state.readyHoldStart >= this.state.readyHoldRequired) {
          // 1.0秒キープ達成 ➔ ロック音発信 & 自動スタート
          this.state.readyHoldStart = null;
          window.AppAudio.playLockSound();
          this.startMeasurementSequence('left');
        }
      } else {
        this.state.readyHoldStart = null;
      }
    }

    // 4. ピーク測定モード中の最大値更新
    if (this.state.mode === 'measuring') {
      const currentActiveVal = this.state.currentSide === 'left' ? (angles.main || 0) : (angles.sub || 0);
      if (currentActiveVal > this.state.peakAngles[this.state.currentSide]) {
        this.state.peakAngles[this.state.currentSide] = currentActiveVal;
      }
    }

    // 5. 動的ドリルモード中のリアルタイム判定
    if (this.state.mode === 'drill' && this.state.drill.isActive) {
      this.handleDrillFrame(angles);
    }
  },

  /**
   * テスト切り替え (胸椎 / 股関節 / もも裏)
   */
  switchTestType(type) {
    if (this.state.mode !== 'idle') return;
    this.state.currentTestType = type;
    window.AppEngine.currentTestType = type;
    window.AppEngine.resetCalibration();
    this.updateTestTypeUi();

    const config = this.TEST_CONFIG[type];
    window.AppAudio.speak(`${config.title}に切り替えました。${config.guide}`);
  },

  updateTestTypeUi() {
    const type = this.state.currentTestType;
    const config = this.TEST_CONFIG[type];

    // タブのアクティブスタイル
    [this.dom.tabThoracic, this.dom.tabHip, this.dom.tabHinge].forEach(el => {
      el.classList.remove('active-tab', 'bg-indigo-700', 'border-indigo-950');
      el.classList.add('bg-slate-800', 'border-slate-950', 'opacity-80');
    });

    const activeTab = type === 'thoracic' ? this.dom.tabThoracic :
                      type === 'hip' ? this.dom.tabHip : this.dom.tabHinge;
    activeTab.classList.add('active-tab', 'bg-indigo-700', 'border-indigo-950');
    activeTab.classList.remove('opacity-80');

    // ガイダンス更新
    this.dom.guideIcon.textContent = config.icon;
    this.dom.guideTitle.textContent = config.title;
    this.dom.guideDesc.textContent = config.guide;

    // リセット
    this.state.peakAngles = { left: 0, right: 0 };
    this.updateDiffDisplay();
  },

  /**
   * 全自動測定シーケンスの実行
   * @param {'left' | 'right'} side
   */
  startMeasurementSequence(side) {
    this.state.currentSide = side;
    this.state.mode = 'counting_down';
    window.AppEngine.resetCalibration();

    const sideText = side === 'left' ? 'ひだり' : 'みぎ';
    window.AppAudio.speak(`${sideText}側の測定をはじめます。姿勢をキープしてね！`);

    // UI初期化
    this.dom.countdownBox.classList.remove('hidden');
    this.dom.countdownGuide.textContent = `${side === 'left' ? '左側' : '右側'}の姿勢をキープ！`;
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
        this.runMeasurePeak(side);
      }
    }, 1000);
  },

  /**
   * ピーク角の記録（4秒間）
   */
  runMeasurePeak(side) {
    this.state.mode = 'measuring';
    this.dom.measuringBadge.classList.remove('hidden');
    window.AppAudio.speak('ぐーっとキープ！');

    // 4秒後にホイッスル
    if (this.state.measureTimer) clearTimeout(this.state.measureTimer);

    this.state.measureTimer = setTimeout(() => {
      this.dom.measuringBadge.classList.add('hidden');
      this.dom.cheatAlertBadge.classList.add('hidden');
      window.AppAudio.playWhistle();

      const measuredVal = this.state.peakAngles[side];
      window.AppAudio.speak(`ナイス！記録は${measuredVal}度です。`);

      if (side === 'left') {
        // 右側の測定へ自動移行（2秒のインターバル）
        setTimeout(() => {
          this.startMeasurementSequence('right');
        }, 2200);
      } else {
        // 左右測定完了 ➔ レポート表示
        this.state.mode = 'idle';
        this.dom.btnStartTrigger.classList.remove('opacity-50', 'pointer-events-none');
        this.updateDiffDisplay();
        setTimeout(() => {
          this.openReportModal();
        }, 1200);
      }
    }, this.state.measureDuration);
  },

  /**
   * 1分動的ストレッチ（音ゲー風反復ドリル）の開始
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
    this.dom.drillStatusText.textContent = `目標: 左右交互に${this.state.drill.targetAngle}度！`;
    this.dom.btnStartTrigger.innerHTML = '<span>⏹️</span><span>ドリル終了</span>';

    window.AppAudio.speak('動的ストレッチドリルスタート！リズムに合わせて大きく動かそう！');

    // 500ms間隔のメトロノームビート
    if (this.state.drill.intervalId) clearInterval(this.state.drill.intervalId);
    this.state.drill.intervalId = setInterval(() => {
      window.AppAudio.playTone(330, 'sine', 0.04, 0, 0.08);
    }, 500);
  },

  /**
   * ドリルのフレーム毎アクション検知
   */
  handleDrillFrame(angles) {
    const drill = this.state.drill;
    const currentActive = angles.activeSide || 'left';
    const angleVal = angles.currentAngle || angles.main || 0;

    // 目標角度の突破検知（反対側に切り替わった時にレップカウント）
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
    window.AppAudio.speak('ドリルクリア！素晴らしいしなりです！');
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
      // 初期デフォルト選手
      const defaultPlayer = {
        id: 'p_' + Date.now(),
        name: 'ルーキー選手',
        dominant: 'right',
        grade: '4'
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
    this.showToast(`選手を切り替えました`);
  },

  handleSaveNewPlayer(e) {
    e.preventDefault();
    const name = this.dom.inputPlayerName.value.trim();
    if (!name) return;

    const newPlayer = {
      id: 'p_' + Date.now(),
      name: name,
      dominant: this.dom.inputPlayerDominant.value,
      grade: this.dom.inputPlayerGrade.value
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

    // ドロップダウンの更新
    const players = this.getStoredPlayers();
    this.dom.playerSelectDropdown.innerHTML = '<option value="">-- 選手を選択してください --</option>' +
      players.map(p => `<option value="${p.id}" ${p.id === player.id ? 'selected' : ''}>${p.name} (${p.grade}年・${p.dominant === 'right' ? '右投' : '左投'})</option>`).join('');
  },

  openReportModal() {
    const left = this.state.peakAngles.left;
    const right = this.state.peakAngles.right;
    const diff = Math.abs(left - right);
    const total = (left + right) || 1;

    // ランク判定
    let grade = 'B';
    let comment = '良好なしなり！左右の差を整えよう！';

    if (left >= 45 && right >= 45 && diff <= 5) {
      grade = 'S';
      comment = '完璧！超一流プロ級のしなりと極上バランス！';
    } else if (left >= 35 && right >= 35 && diff <= 10) {
      grade = 'A';
      comment = '素晴らしい柔軟性！球速UP間違いなし！';
    } else if (diff > 15) {
      grade = 'C';
      comment = '左右差が目立ちます。硬い方を重点ストレッチ！';
    }

    this.dom.reportScoreGrade.textContent = grade;
    this.dom.reportComment.textContent = comment;
    this.dom.reportLeftVal.textContent = `${left}°`;
    this.dom.reportRightVal.textContent = `${right}°`;

    // 左右バーの比率設定
    const leftRatio = Math.round((left / total) * 100);
    const rightRatio = 100 - leftRatio;
    this.dom.barLeft.style.width = `${leftRatio}%`;
    this.dom.barRight.style.width = `${rightRatio}%`;

    this.dom.reportModal.classList.remove('hidden');
    window.AppAudio.speak(`測定結果です。総合しなりランクは${grade}です！`);
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

    this.showToast('測定結果をカルテに保存しました！');
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
    link.setAttribute('download', `しなりドック履歴_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.showToast('CSVファイルを書き出しました');
  },

  shareToLine() {
    const player = this.getActivePlayer();
    const left = this.state.peakAngles.left;
    const right = this.state.peakAngles.right;
    const diff = Math.abs(left - right);
    const testName = this.TEST_CONFIG[this.state.currentTestType].title;

    const message = `【柔軟性・しなりドック 測定結果】\n選手: ${player.name}\n種目: ${testName}\n左: ${left}° / 右: ${right}° (左右差: ${diff}°)\nしなりドックで可動域を鍛えよう！`;
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

  updatePoseBadge(isReady, message) {
    if (isReady) {
      this.dom.triggerDot.classList.remove('bg-red-500');
      this.dom.triggerDot.classList.add('bg-emerald-400');
      this.dom.triggerText.textContent = '構えOK！1秒キープ';
      this.dom.triggerText.classList.add('text-emerald-300');
    } else {
      this.dom.triggerDot.classList.remove('bg-emerald-400');
      this.dom.triggerDot.classList.add('bg-red-500');
      this.dom.triggerText.textContent = message || '全身認識待ち';
      this.dom.triggerText.classList.remove('text-emerald-300');
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
