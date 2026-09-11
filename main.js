/**
 * 🦴 柔軟性・しなりドック - Main Application Controller (js/app.js)
 * 全体状態管理、全自動フルボイス進行、音ゲー風動的ドリル、
 * 複数選手カルテ管理（LocalStorage）、およびUI操作を一元制御します。
 */
(function() {
  'use strict';

  // 定数定義
  const STORAGE_KEYS = {
    PLAYERS: 'mobility_players_v1',
    ACTIVE_PLAYER: 'mobility_active_player_v1',
    RECORDS: 'mobility_records_v1'
  };

  const TEST_MODES = {
    HIP: 'tab-hip',
    BANZAI: 'tab-banzai',
    SHOULDER2ND: 'tab-shoulder2nd',
    HINGE: 'tab-hinge'
  };

  const TEST_GUIDANCE = {
    [TEST_MODES.HIP]: {
      icon: '🦊',
      title: '① 股関節ワイパー',
      desc: '仰向けで膝を立て、片足ずつ外に倒す',
      voice: '股関節ワイパー！仰向けに寝て膝を立てたら、手首を耳元につけて構えてね！準備ができたら片足ずつ外側にパタッと倒そう！'
    },
    [TEST_MODES.BANZAI]: {
      icon: '🦅',
      title: '② 両腕バンザイ',
      desc: '両腕を限界まで高く挙げてキープ！',
      voice: '両腕バンザイテスト！カメラに正面を向いて立とう！手首を耳元に合わせて構えたら、限界まで高く腕をバンザイしよう！'
    },
    [TEST_MODES.SHOULDER2ND]: {
      icon: '⚾',
      title: '③ 肩2nd内外旋',
      desc: '肩と肘を90度に開き、前腕を倒す',
      voice: '肩のしなりテスト！カメラに対して横向きに立とう！肩と肘を90度に開いて前腕を水平にしたらスタート！腕を天井側と床側へ倒してね！'
    },
    [TEST_MODES.HINGE]: {
      icon: '📐',
      title: '④ もも裏ヒンジ',
      desc: '胸を張ってお尻を後ろに引いて前屈',
      voice: 'もも裏ヒンジテスト！カメラに対して横向きに直立しよう！背筋をピンと伸ばしてスタンバイ！胸を張ったまま、お尻を後ろに引いて前屈しよう！'
    }
  };

  const COACH_LINES = {
    stanceReady: 'いいね！その姿勢をキープ！',
    countdown: '息を吐きながら、限界まで大きく動かしてキープ！',
    measuring: 'ナイスしなり！そのままキープ！あと少し！'
  };

  const APP_STATES = {
    IDLE: 'TEST_IDLE',
    COUNTDOWN: 'COUNTDOWN',
    MEASURING: 'MEASURING',
    DRILL_ACTIVE: 'DRILL_ACTIVE'
  };

  const AppState = {
    currentStatus: APP_STATES.IDLE,
    currentTestMode: TEST_MODES.HIP,
    currentSide: 'LEFT', // 'LEFT' | 'RIGHT' | 'BOTH'
    isStanceHolding: false,
    stanceHoldStartTime: 0,
    countdownTimer: null,
    measureTimer: null,
    currentMetrics: { main: 0, sub: 0 },
    peakMetricLeft: 0,
    peakMetricRight: 0,
    peakMetricBoth: 0,
    isCheatDetected: false,
    activePlayerId: 'guest',
    activePlayerName: 'GUEST',
    hasAnnouncedStanceReady: false
  };

  const AppStorage = {
    getPlayers() {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.PLAYERS);
        return data ? JSON.parse(data) : [{ id: 'guest', name: 'GUEST', createdAt: Date.now() }];
      } catch (e) {
        console.warn('Failed to load players:', e);
        return [{ id: 'guest', name: 'GUEST', createdAt: Date.now() }];
      }
    },

    savePlayers(players) {
      try {
        localStorage.setItem(STORAGE_KEYS.PLAYERS, JSON.stringify(players));
      } catch (e) {
        console.error('Failed to save players:', e);
      }
    },

    addPlayer(name) {
      if (!name || !name.trim()) return null;
      const players = this.getPlayers();
      const newPlayer = {
        id: 'p_' + Date.now(),
        name: name.trim(),
        createdAt: Date.now()
      };
      players.push(newPlayer);
      this.savePlayers(players);
      this.setActivePlayer(newPlayer.id);
      return newPlayer;
    },

    getActivePlayer() {
      const players = this.getPlayers();
      const activeId = localStorage.getItem(STORAGE_KEYS.ACTIVE_PLAYER) || 'guest';
      const found = players.find(p => p.id === activeId);
      return found || players[0];
    },

    setActivePlayer(playerId) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_PLAYER, playerId);
      const player = this.getActivePlayer();
      AppState.activePlayerId = player.id;
      AppState.activePlayerName = player.name;
      AppUI.updatePlayerBadge();
    },

    getRecords() {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.RECORDS);
        return data ? JSON.parse(data) : [];
      } catch (e) {
        console.warn('Failed to load records:', e);
        return [];
      }
    },

    addRecord(record) {
      try {
        const records = this.getRecords();
        records.unshift(record);
        // 最大100件まで保持
        if (records.length > 100) records.length = 100;
        localStorage.setItem(STORAGE_KEYS.RECORDS, JSON.stringify(records));
      } catch (e) {
        console.error('Failed to store record:', e);
      }
    },

    clearRecords() {
      try {
        localStorage.removeItem(STORAGE_KEYS.RECORDS);
      } catch (e) {
        console.error('Failed to clear records:', e);
      }
    },

    /**
     * ポジティブ評価ランク算出（減点ゼロ・ブロスタ風称号）
     */
    evaluateScore(testMode, leftVal, rightVal) {
      let maxVal = Math.max(leftVal || 0, rightVal || 0);
      let diff = Math.abs((leftVal || 0) - (rightVal || 0));

      if (testMode === TEST_MODES.BANZAI) {
        maxVal = Math.min(leftVal, rightVal); // 両腕バンザイは低い方もしっかり見る
      }

      let rank = 'A';
      let title = '⚡ LEVEL 2 実戦しなりマスター';
      let note = '関節が柔軟にしなり、投球・打撃への連動性が高い状態です！';

      if (testMode === TEST_MODES.HIP) {
        if (maxVal >= 45) {
          rank = 'S';
          title = '🌟 SUPER DRAGON 達成！';
          note = 'プロ級の股関節可動域！下半身のタメを爆発的な回旋力に変換できます。';
        } else if (maxVal >= 35) {
          rank = 'A';
          title = '🔥 LEVEL 2 実戦しなりマスター';
          note = '鋭い骨盤回旋の土台が整っています。左右差を整えるともっと伸びます！';
        } else {
          rank = 'B';
          title = '🌱 LEVEL 1 伸びしろルーキー';
          note = 'サビ取りドリルで骨盤まわりをほぐせば、スイングスピードが即座にアップします！';
        }
      } else if (testMode === TEST_MODES.BANZAI) {
        if (maxVal >= 170) {
          rank = 'S';
          title = '🦅 スカイイーグル達成！';
          note = '胸郭と肩甲骨が完璧に連動！ゼロポジションでの力強いスイングが可能です。';
        } else if (maxVal >= 150) {
          rank = 'A';
          title = '🔥 LEVEL 2 実戦しなりマスター';
          note = '肩甲骨の引き上げが良好です。投球時の腕の振りが滑らかです！';
        } else {
          rank = 'B';
          title = '🌱 LEVEL 1 伸びしろルーキー';
          note = '広背筋をストレッチすることで、高めの打球や伸びる送球が手に入ります！';
        }
      } else if (testMode === TEST_MODES.SHOULDER2ND) {
        const totalArc = leftVal + rightVal;
        if (totalArc >= 160) {
          rank = 'S';
          title = '⚾ ゴールデンアーム達成！';
          note = '肩の後方タイトネスがなく理想的なしなり。肘・肩の怪我リスクが極めて低いです。';
        } else if (totalArc >= 135) {
          rank = 'A';
          title = '🔥 LEVEL 2 実戦しなりマスター';
          note = '内外旋のバランスが安定しています。投球後のケアを継続しましょう！';
        } else {
          rank = 'B';
          title = '🌱 LEVEL 1 伸びしろルーキー';
          note = '肩後面のサビ取りドリルで、腕の振りの抜けが抜群に良くなります！';
        }
      } else if (testMode === TEST_MODES.HINGE) {
        if (maxVal >= 80) {
          rank = 'S';
          title = '📐 パーフェクトヒンジ達成！';
          note = 'ハムストリングスと骨盤の連動が完璧！低めのボールも腰を痛めず拾えます。';
        } else if (maxVal >= 65) {
          rank = 'A';
          title = '🔥 LEVEL 2 実戦しなりマスター';
          note = '腰椎の代償が少なく綺麗な前傾です。安定した送球姿勢を作れます！';
        } else {
          rank = 'B';
          title = '🌱 LEVEL 1 伸びしろルーキー';
          note = 'もも裏の柔軟性を高めると、捕球姿勢が一段と低く安定します！';
        }
      }

      return { rank, title, note, diff };
    }
  };

  const AppDrill = {
    isActive: false,
    intervalId: null,
    bpm: 120, // 500ms周期
    combo: 0,
    targetReps: 10,
    currentReps: 0,
    hasPassedThreshold: false,

    start() {
      if (this.isActive) return;
      this.isActive = true;
      AppState.currentStatus = APP_STATES.DRILL_ACTIVE;
      this.combo = 0;
      this.currentReps = 0;
      this.hasPassedThreshold = false;

      // HUD表示
      AppUI.elements.drillHud.classList.remove('hidden');
      this.updateHud();

      if (window.AppAudio) {
        window.AppAudio.speak('動的サビ取りドリルスタート！リズムに乗って10回動かそう！');
      }

      const beatDuration = (60 / this.bpm) * 1000;
      this.intervalId = setInterval(() => {
        if (!this.isActive) return;
        // メトロノーム音
        if (window.AppAudio) {
          window.AppAudio.playTone(440, 0.04, 'sine', 0.05);
        }
      }, beatDuration);
    },

    feedAngle(angle) {
      if (!this.isActive) return;

      const threshold = 35; // ドリルの動的ターゲット閾値
      if (angle >= threshold && !this.hasPassedThreshold) {
        this.hasPassedThreshold = true;
        this.combo++;
        this.currentReps++;

        if (window.AppAudio) {
          window.AppAudio.playComboPing();
        }

        // 衝撃波エフェクト
        AppUI.triggerComboEffect();
        this.updateHud();

        if (this.currentReps >= this.targetReps) {
          this.complete();
        }
      } else if (angle < threshold * 0.6) {
        this.hasPassedThreshold = false;
      }
    },

    updateHud() {
      AppUI.elements.drillComboCounter.innerText = `${this.combo} COMBO!`;
      AppUI.elements.drillProgressCount.innerText = `${this.currentReps} / ${this.targetReps}`;
      AppUI.elements.drillStatusText.innerText = this.currentReps >= this.targetReps ? 'COMPLETE!' : 'PUMP IT!';
    },

    complete() {
      this.stop();
      if (window.AppAudio) {
        window.AppAudio.playFanfare();
        window.AppAudio.speak('サビ取り完了！可動域が広がったよ！測定で確かめよう！');
      }
      AppUI.showToast('🔥 サビ取りドリル完了！可動域UP！');
      // 自動で再測定モードへスタンバイ
      setTimeout(() => {
        AppTestOrchestrator.startMeasurementSequence();
      }, 1500);
    },

    stop() {
      this.isActive = false;
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      AppState.currentStatus = APP_STATES.IDLE;
      AppUI.elements.drillHud.classList.add('hidden');
    }
  };

  const AppTestOrchestrator = {
    /**
     * 構え認識コールバック（1.0秒キープで自動トリガー）
     */
    handleTriggerReady(isReady, message) {
      AppUI.updateTriggerBadge(isReady, message);

      if (AppState.currentStatus !== APP_STATES.IDLE) {
        if (!isReady) AppState.hasAnnouncedStanceReady = false;
        return;
      }

      if (isReady) {
        if (!AppState.hasAnnouncedStanceReady && window.AppAudio) {
          window.AppAudio.speak(COACH_LINES.stanceReady);
        }
        AppState.hasAnnouncedStanceReady = true;

        if (!AppState.isStanceHolding) {
          AppState.isStanceHolding = true;
          AppState.stanceHoldStartTime = Date.now();
        } else {
          const elapsed = Date.now() - AppState.stanceHoldStartTime;
          if (elapsed >= 1000) {
            // 構え1秒キープ達成！自動スタート
            AppState.isStanceHolding = false;
            this.startMeasurementSequence();
          }
        }
      } else {
        AppState.isStanceHolding = false;
        AppState.hasAnnouncedStanceReady = false;
      }
    },

    startMeasurementSequence() {
      if (AppState.currentStatus === APP_STATES.COUNTDOWN || AppState.currentStatus === APP_STATES.MEASURING) return;

      AppState.isStanceHolding = false;
      AppState.hasAnnouncedStanceReady = false;
      AppState.currentStatus = APP_STATES.COUNTDOWN;
      if (window.AppAudio) {
        window.AppAudio.playLockSound();
      }

      let count = 3;
      AppUI.showCountdown(count, COACH_LINES.countdown);
      if (window.AppAudio) {
        window.AppAudio.speak(COACH_LINES.countdown);
      }

      if (AppState.countdownTimer) clearInterval(AppState.countdownTimer);
      AppState.countdownTimer = setInterval(() => {
        count--;
        if (count > 0) {
          AppUI.showCountdown(count, COACH_LINES.countdown);
          if (window.AppAudio) {
            window.AppAudio.playTone(880, 0.08, 'triangle', 0.1);
          }
        } else if (count === 0) {
          clearInterval(AppState.countdownTimer);
          AppState.countdownTimer = null;
          this.beginMeasuringWindow();
        }
      }, 1000);
    },

    beginMeasuringWindow() {
      AppState.currentStatus = APP_STATES.MEASURING;
      AppUI.hideCountdown();
      AppUI.showMeasuringBadge(true);

      // ピーク初期化
      AppState.peakMetricLeft = 0;
      AppState.peakMetricRight = 0;
      AppState.peakMetricBoth = 0;

      if (window.AppAudio) {
        window.AppAudio.playTone(1200, 0.2, 'sine', 0.15);
        window.AppAudio.speak(COACH_LINES.measuring);
      }

      let duration = 4000; // 4秒間のピークホールド測定
      const startTime = Date.now();

      if (AppState.measureTimer) clearInterval(AppState.measureTimer);
      AppState.measureTimer = setInterval(() => {
        const remaining = duration - (Date.now() - startTime);

        // リアルタイムピーク更新
        if (AppState.currentMetrics.main > AppState.peakMetricLeft) {
          AppState.peakMetricLeft = AppState.currentMetrics.main;
        }
        if (AppState.currentMetrics.sub > AppState.peakMetricRight) {
          AppState.peakMetricRight = AppState.currentMetrics.sub;
        }

        if (remaining <= 0) {
          clearInterval(AppState.measureTimer);
          AppState.measureTimer = null;
          this.finishMeasurement();
        }
      }, 100);
    },

    finishMeasurement() {
      AppState.currentStatus = APP_STATES.IDLE;
      AppUI.showMeasuringBadge(false);

      if (window.AppAudio) {
        window.AppAudio.playWhistle();
      }

      const lVal = AppState.peakMetricLeft;
      const rVal = AppState.peakMetricRight;
      const evalResult = AppStorage.evaluateScore(AppState.currentTestMode, lVal, rVal);

      // 記録保存
      const record = {
        id: 'rec_' + Date.now(),
        playerId: AppState.activePlayerId,
        playerName: AppState.activePlayerName,
        testMode: AppState.currentTestMode,
        timestamp: Date.now(),
        leftVal: lVal,
        rightVal: rVal,
        rank: evalResult.rank,
        title: evalResult.title
      };
      AppStorage.addRecord(record);

      // 左右差バッジの更新
      AppUI.updateDiffBadge(evalResult.diff);

      if (window.AppAudio) {
        window.AppAudio.speak(`測定完了！ピーク角度は、左${lVal}度、右${rVal}度！${evalResult.title}！`);
      }

      // レポートモーダルの更新＆表示
      setTimeout(() => {
        AppUI.renderReport(record, evalResult);
        AppUI.openModal('report-modal');
      }, 800);
    }
  };

  const AppUI = {
    elements: {},

    initElements() {
      this.elements = {
        // ヘッダー
        btnPlayerSelect: document.getElementById('btn-player-select'),
        headerPlayerName: document.getElementById('header-player-name'),
        btnDiffBadge: document.getElementById('btn-diff-badge'),
        headerDiffVal: document.getElementById('header-diff-val'),
        btnOpenCarte: document.getElementById('btn-open-carte'),
        btnSwitchCamera: document.getElementById('btn-switch-camera'),
        tabs: {
          [TEST_MODES.HIP]: document.getElementById(TEST_MODES.HIP),
          [TEST_MODES.BANZAI]: document.getElementById(TEST_MODES.BANZAI),
          [TEST_MODES.SHOULDER2ND]: document.getElementById(TEST_MODES.SHOULDER2ND),
          [TEST_MODES.HINGE]: document.getElementById(TEST_MODES.HINGE)
        },
        // ガイダンス
        guideIcon: document.getElementById('guide-icon'),
        guideTitle: document.getElementById('guide-title'),
        guideDesc: document.getElementById('guide-desc'),
        triggerDot: document.getElementById('trigger-dot'),
        triggerText: document.getElementById('trigger-text'),
        // カメラ・計測HUD
        video: document.getElementById('webcam-video'),
        canvas: document.getElementById('output-canvas'),
        safeBoundary: document.getElementById('safe-boundary'),
        metricMainVal: document.getElementById('metric-main-val'),
        metricSubVal: document.getElementById('metric-sub-val'),
        countdownBox: document.getElementById('countdown-box'),
        countdownNum: document.getElementById('countdown-num'),
        countdownGuide: document.getElementById('countdown-guide'),
        measuringBadge: document.getElementById('measuring-badge'),
        cheatAlertBadge: document.getElementById('cheat-alert-badge'),
        cheatAlertText: document.getElementById('cheat-alert-text'),
        // ドリルHUD
        drillHud: document.getElementById('drill-hud'),
        drillComboCounter: document.getElementById('drill-combo-counter'),
        drillProgressCount: document.getElementById('drill-progress-count'),
        drillStatusText: document.getElementById('drill-status-text'),
        // 下部ボタン
        btnStartTrigger: document.getElementById('btn-start-trigger'),
        btnOpenReport: document.getElementById('btn-open-report'),
        btnOpenDynamicDrill: document.getElementById('btn-open-dynamic-drill'),
        // モーダル
        playerModal: document.getElementById('player-modal'),
        reportModal: document.getElementById('report-modal'),
        carteModal: document.getElementById('carte-modal'),
        toastBox: document.getElementById('toast-box')
      };
    },

    bindEvents() {
      // カメラ起動＆イン/外切替
      if (this.elements.btnSwitchCamera) {
        this.elements.btnSwitchCamera.addEventListener('click', async () => {
          if (window.AppEngine) {
            this.elements.btnSwitchCamera.disabled = true;
            try {
              const facing = await window.AppEngine.switchCamera();
              this.adjustCameraMirror(facing === 'user');
              this.showToast(facing === 'user' ? '🔄 インカメラに切り替えました' : '🔄 外カメラに切り替えました');
            } finally {
              this.elements.btnSwitchCamera.disabled = false;
            }
          }
        });
      }

      // スタートボタン
      if (this.elements.btnStartTrigger) {
        this.elements.btnStartTrigger.addEventListener('click', () => {
          if (window.AppAudio) window.AppAudio.playTap();
          AppTestOrchestrator.startMeasurementSequence();
        });
      }

      // 動的ドリルボタン
      if (this.elements.btnOpenDynamicDrill) {
        this.elements.btnOpenDynamicDrill.addEventListener('click', () => {
          if (window.AppAudio) window.AppAudio.playTap();
          if (AppDrill.isActive) {
            AppDrill.stop();
          } else {
            AppDrill.start();
          }
        });
      }

      // レポートボタン
      if (this.elements.btnOpenReport) {
        this.elements.btnOpenReport.addEventListener('click', () => {
          if (window.AppAudio) window.AppAudio.playTap();
          const records = AppStorage.getRecords();
          if (records.length > 0) {
            const last = records[0];
            const evalResult = AppStorage.evaluateScore(last.testMode, last.leftVal, last.rightVal);
            this.renderReport(last, evalResult);
          }
          this.openModal('report-modal');
        });
      }

      // 選手選択モーダルボタン
      if (this.elements.btnPlayerSelect) {
        this.elements.btnPlayerSelect.addEventListener('click', () => {
          if (window.AppAudio) window.AppAudio.playTap();
          this.renderPlayerList();
          this.openModal('player-modal');
        });
      }

      // カルテモーダルボタン
      if (this.elements.btnOpenCarte) {
        this.elements.btnOpenCarte.addEventListener('click', () => {
          if (window.AppAudio) window.AppAudio.playTap();
          this.renderCarteList();
          this.openModal('carte-modal');
        });
      }

      // モーダル閉じるボタンのバインド
      document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const modal = e.target.closest('.fixed');
          if (modal) modal.classList.add('hidden');
          if (window.AppAudio) window.AppAudio.playTap();
        });
      });

      Object.entries(this.elements.tabs).forEach(([modeKey, tabBtn]) => {
        if (!tabBtn) return;
        tabBtn.addEventListener('click', () => {
          this.switchTestTab(modeKey);
        });
      });

      // 選手新規登録ボタン
      const playerModal = this.elements.playerModal;
      if (playerModal) {
        const input = playerModal.querySelector('input');
        const addBtn = playerModal.querySelector('button.bg-blue-600');
        if (addBtn && input) {
          addBtn.addEventListener('click', () => {
            const name = input.value;
            if (name.trim()) {
              AppStorage.addPlayer(name);
              input.value = '';
              this.renderPlayerList();
              this.showToast(`👤 選手「${name.trim()}」を登録しました！`);
            }
          });
        }
      }

      // カルテ操作（CSV・LINE・消去）
      const carteModal = this.elements.carteModal;
      if (carteModal) {
        const csvBtn = carteModal.querySelector('button.bg-green-600');
        const lineBtn = carteModal.querySelector('button.bg-\\[\\#06C755\\]');
        const clearBtn = carteModal.querySelector('button.bg-red-600');

        if (csvBtn) csvBtn.addEventListener('click', () => this.exportCSV());
        if (lineBtn) lineBtn.addEventListener('click', () => this.shareLine());
        if (clearBtn) clearBtn.addEventListener('click', () => {
          AppStorage.clearRecords();
          this.renderCarteList();
          this.showToast('🗑️ カルテ履歴を消去しました');
        });
      }
    },

    switchTestTab(tabId) {
      AppState.currentTestMode = tabId;
      if (window.AppEngine) {
        window.AppEngine.setTestMode(tabId);
      }

      const activeClasses = ['border-yellow-400', 'text-yellow-400'];
      const inactiveClasses = ['border-transparent', 'text-slate-400', 'hover:bg-slate-600', 'hover:text-white'];

      Object.entries(this.elements.tabs).forEach(([id, btn]) => {
        if (!btn) return;
        const iconSpan = btn.querySelector('span');
        if (id === tabId) {
          btn.classList.remove(...inactiveClasses);
          btn.classList.add(...activeClasses);
          if (iconSpan) iconSpan.classList.remove('opacity-50');
        } else {
          btn.classList.remove(...activeClasses);
          btn.classList.add(...inactiveClasses);
          if (iconSpan) iconSpan.classList.add('opacity-50');
        }
      });

      const guide = TEST_GUIDANCE[tabId];
      if (guide) {
        if (this.elements.guideIcon) this.elements.guideIcon.innerText = guide.icon;
        if (this.elements.guideTitle) this.elements.guideTitle.innerText = guide.title;
        if (this.elements.guideDesc) this.elements.guideDesc.innerText = guide.desc;
        if (window.AppAudio) {
          window.AppAudio.speak(guide.voice);
        }
      }
    },

    adjustCameraMirror(isMirror) {
      if (this.elements.video) {
        this.elements.video.style.transform = isMirror ? 'scaleX(-1)' : 'none';
      }
      if (this.elements.canvas) {
        this.elements.canvas.style.transform = isMirror ? 'scaleX(-1)' : 'none';
      }
    },

    updatePlayerBadge() {
      if (this.elements.headerPlayerName) {
        this.elements.headerPlayerName.innerText = AppState.activePlayerName;
      }
    },

    updateDiffBadge(diff) {
      if (!this.elements.btnDiffBadge || !this.elements.headerDiffVal) return;
      if (diff > 0) {
        this.elements.btnDiffBadge.classList.remove('hidden');
        this.elements.headerDiffVal.innerText = `左右差 ${diff}°`;
      } else {
        this.elements.btnDiffBadge.classList.add('hidden');
      }
    },

    updateTriggerBadge(isReady, message) {
      if (!this.elements.triggerDot || !this.elements.triggerText) return;
      if (isReady) {
        this.elements.triggerDot.classList.remove('bg-rose-500', 'shadow-[0_0_5px_#f43f5e]');
        this.elements.triggerDot.classList.add('bg-emerald-400', 'shadow-[0_0_8px_#34d399]');
        this.elements.triggerText.innerText = message || 'スタンバイOK！';
        this.elements.triggerText.classList.add('text-emerald-300');
      } else {
        this.elements.triggerDot.classList.remove('bg-emerald-400', 'shadow-[0_0_8px_#34d399]');
        this.elements.triggerDot.classList.add('bg-rose-500', 'shadow-[0_0_5px_#f43f5e]');
        this.elements.triggerText.innerText = message || '構え検知待機';
        this.elements.triggerText.classList.remove('text-emerald-300');
      }
    },

    updateMetrics(main, sub) {
      AppState.currentMetrics.main = main;
      AppState.currentMetrics.sub = sub;

      if (this.elements.metricMainVal) {
        this.elements.metricMainVal.classList.remove('hidden');
        this.elements.metricMainVal.innerText = `${main}°`;
      }
      if (this.elements.metricSubVal) {
        this.elements.metricSubVal.classList.remove('hidden');
        this.elements.metricSubVal.innerText = `${sub}°`;
      }

      // ドリル動作中なら反復判定へ流す
      if (AppDrill.isActive) {
        AppDrill.feedAngle(Math.max(main, sub));
      }
    },

    updateCheatAlert(isCheating, text) {
      AppState.isCheatDetected = isCheating;
      if (!this.elements.cheatAlertBadge) return;
      if (isCheating) {
        this.elements.cheatAlertBadge.classList.remove('hidden');
        if (this.elements.cheatAlertText) this.elements.cheatAlertText.innerText = text;
      } else {
        this.elements.cheatAlertBadge.classList.add('hidden');
      }
    },

    showCountdown(num, guideText) {
      if (!this.elements.countdownBox) return;
      this.elements.countdownBox.classList.remove('hidden');
      if (this.elements.countdownNum) this.elements.countdownNum.innerText = num;
      if (this.elements.countdownGuide) this.elements.countdownGuide.innerText = guideText;
    },

    hideCountdown() {
      if (this.elements.countdownBox) {
        this.elements.countdownBox.classList.add('hidden');
      }
    },

    showMeasuringBadge(show) {
      if (this.elements.measuringBadge) {
        if (show) this.elements.measuringBadge.classList.remove('hidden');
        else this.elements.measuringBadge.classList.add('hidden');
      }
    },

    triggerComboEffect() {
      if (this.elements.safeBoundary) {
        this.elements.safeBoundary.style.borderColor = '#facc15';
        this.elements.safeBoundary.style.boxShadow = '0 0 20px #facc15';
        setTimeout(() => {
          this.elements.safeBoundary.style.borderColor = '';
          this.elements.safeBoundary.style.boxShadow = '';
        }, 200);
      }
    },

    openModal(modalId) {
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.remove('hidden');
    },

    closeModal(modalId) {
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.add('hidden');
    },

    renderPlayerList() {
      if (!this.elements.playerModal) return;
      const container = this.elements.playerModal.querySelector('.flex-1');
      if (!container) return;

      const players = AppStorage.getPlayers();
      container.innerHTML = '';

      players.forEach(p => {
        const row = document.createElement('div');
        const isActive = p.id === AppState.activePlayerId;
        row.className = `p-3 rounded-xl border flex justify-between items-center cursor-pointer transition-all ${isActive ? 'bg-blue-600/30 border-blue-400' : 'bg-slate-700/50 border-slate-600 hover:bg-slate-700'}`;
        row.innerHTML = `
          <div class="flex items-center gap-2">
            <span class="text-lg">${isActive ? '⭐' : '👤'}</span>
            <span class="font-bold text-sm sm:text-base text-white">${p.name}</span>
          </div>
          ${isActive ? '<span class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded-full font-bold">選択中</span>' : ''}
        `;
        row.addEventListener('click', () => {
          AppStorage.setActivePlayer(p.id);
          this.renderPlayerList();
          this.showToast(`👤 選手を「${p.name}」に変更しました`);
        });
        container.appendChild(row);
      });
    },

    renderCarteList() {
      if (!this.elements.carteModal) return;
      const container = this.elements.carteModal.querySelector('.flex-1');
      if (!container) return;

      const records = AppStorage.getRecords();
      if (records.length === 0) {
        container.innerHTML = '<div class="text-center text-slate-400 text-xs sm:text-sm py-8">測定データがまだありません</div>';
        return;
      }

      container.innerHTML = '';
      records.forEach(r => {
        const item = document.createElement('div');
        item.className = 'mb-2 p-3 bg-slate-900/80 rounded-xl border border-slate-700 flex justify-between items-center';
        const dateStr = new Date(r.timestamp).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        item.innerHTML = `
          <div>
            <div class="flex items-center gap-1.5 mb-1">
              <span class="text-xs font-black px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">${r.rank}</span>
              <span class="text-xs font-bold text-slate-300">${r.playerName}</span>
            </div>
            <div class="text-[11px] text-slate-400 font-bold">${dateStr}</div>
          </div>
          <div class="text-right">
            <div class="text-sm font-black text-white">L: ${r.leftVal}° / R: ${r.rightVal}°</div>
            <div class="text-[10px] text-emerald-400 font-bold">${r.title}</div>
          </div>
        `;
        container.appendChild(item);
      });
    },

    renderReport(record, evalResult) {
      if (!this.elements.reportModal) return;
      const modal = this.elements.reportModal;

      const rankBadge = modal.querySelector('.text-4xl.font-black');
      if (rankBadge) {
        rankBadge.innerText = `${evalResult.rank} ランク`;
      }

      const noteEl = modal.querySelector('p.text-\\[11px\\]');
      if (noteEl) {
        noteEl.innerText = `${evalResult.title}\n${evalResult.note}`;
      }

      // 左右差プログレスバー
      const bars = modal.querySelectorAll('.bg-blue-500, .bg-rose-500');
      if (bars.length >= 2) {
        const total = (record.leftVal || 1) + (record.rightVal || 1);
        const lPercent = Math.round(((record.leftVal || 1) / total) * 100);
        const rPercent = 100 - lPercent;
        bars[0].style.width = `${lPercent}%`;
        bars[1].style.width = `${rPercent}%`;
      }
    },

    exportCSV() {
      const records = AppStorage.getRecords();
      if (records.length === 0) {
        this.showToast('出力するデータがありません');
        return;
      }

      let csv = '日時,選手名,種目,左角度,右角度,ランク,評価\n';
      records.forEach(r => {
        const date = new Date(r.timestamp).toLocaleString('ja-JP');
        csv += `"${date}","${r.playerName}","${r.testMode}",${r.leftVal},${r.rightVal},"${r.rank}","${r.title}"\n`;
      });

      const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mobility_records_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast('📥 CSVファイルをダウンロードしました');
    },

    shareLine() {
      const records = AppStorage.getRecords();
      if (records.length === 0) {
        this.showToast('共有するデータがありません');
        return;
      }
      const last = records[0];
      const text = `【🦴 柔軟性・しなりドック 測定結果】\n選手: ${last.playerName}\n評価: ${last.rank}ランク (${last.title})\n数値: 左 ${last.leftVal}° / 右 ${last.rightVal}°\n#野球可動域 #しなりドック`;
      const lineUrl = `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
      window.open(lineUrl, '_blank');
    },

    showToast(message) {
      if (!this.elements.toastBox) return;
      const textEl = this.elements.toastBox.querySelector('.toast-message');
      if (textEl) textEl.innerText = message;

      this.elements.toastBox.classList.remove('hidden');
      setTimeout(() => {
        this.elements.toastBox.classList.remove('translate-y-[-20px]', 'opacity-0');
      }, 10);

      setTimeout(() => {
        this.elements.toastBox.classList.add('translate-y-[-20px]', 'opacity-0');
        setTimeout(() => this.elements.toastBox.classList.add('hidden'), 300);
      }, 2500);
    }
  };

  const App = {
    State: AppState,
    Storage: AppStorage,
    Drill: AppDrill,
    Orchestrator: AppTestOrchestrator,
    UI: AppUI,

    init() {
      AppUI.initElements();
      AppUI.bindEvents();

      const activePlayer = AppStorage.getActivePlayer();
      AppState.activePlayerId = activePlayer.id;
      AppState.activePlayerName = activePlayer.name;
      AppUI.updatePlayerBadge();

      // Pose & Geometry Engine 初期化
      if (window.AppEngine) {
        window.AppEngine.init({
          videoElement: AppUI.elements.video,
          canvasElement: AppUI.elements.canvas,
          onResults: (landmarks, bounds) => {
            // 必要に応じたフレームごとの追加処理
          },
          onTriggerReady: (isReady, message) => {
            AppTestOrchestrator.handleTriggerReady(isReady, message);
          },
          onMetricUpdate: (main, sub) => {
            AppUI.updateMetrics(main, sub);
          },
          onCheatAlert: (isCheating, text) => {
            AppUI.updateCheatAlert(isCheating, text);
          }
        });

        // 実機カメラの起動
        window.AppEngine.startCamera().then(() => {
          AppUI.adjustCameraMirror(true);
        }).catch(err => {
          console.warn('Camera autostart failed:', err);
        });
      }

      if (window.AppAudio) {
        window.AppAudio.speak('柔軟性・しなりドックへようこそ！姿勢を合わせてスタートしよう！');
      }
    }
  };

  // グローバル公開
  window.App = App;

  // DOMロード時の自動ブートストラップ
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }

})();
