/**
 * 🦴 柔軟性・しなりドック - Pose & Geometry Engine (js/engine.js)
 * MediaPipe Pose を活用した実機カメラ制御、アスペクト比補正（object-fit: coverのズレ解消）、
 * 顔正対×構え判定、確定4大テストの精密幾何計算、およびカンニング検知を一元管理します。
 */
(function() {
  'use strict';

  let videoElement = null;
  let canvasElement = null;
  let canvasCtx = null;
  let poseInstance = null;
  let cameraInstance = null;

  let currentFacingMode = 'user'; // 'user' (イン) または 'environment' (アウト)
  let isRunning = false;
  let currentTestMode = 'tab-hip'; // 'tab-hip' | 'tab-banzai' | 'tab-shoulder2nd' | 'tab-hinge'

  let onResultsCallback = null;
  let onTriggerReadyCallback = null;
  let onMetricUpdateCallback = null;
  let onCheatAlertCallback = null;

  const AppEngine = {
    /**
     * エンジンの初期化
     * @param {Object} config 各種DOM要素やコールバック
     */
    init(config) {
      videoElement = config.videoElement;
      canvasElement = config.canvasElement;
      if (canvasElement) {
        canvasCtx = canvasElement.getContext('2d');
      }
      onResultsCallback = config.onResults || null;
      onTriggerReadyCallback = config.onTriggerReady || null;
      onMetricUpdateCallback = config.onMetricUpdate || null;
      onCheatAlertCallback = config.onCheatAlert || null;

      this.initPoseModel();
    },

    /**
     * MediaPipe Pose モデルのセットアップ
     */
    initPoseModel() {
      if (typeof window.Pose === 'undefined') {
        console.warn('MediaPipe Pose script not loaded yet. Retrying...');
        setTimeout(() => this.initPoseModel(), 500);
        return;
      }

      try {
        poseInstance = new window.Pose({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
        });

        poseInstance.setOptions({
          modelComplexity: 1,
          smoothLandmarks: true,
          enableSegmentation: false,
          smoothSegmentation: false,
          minDetectionConfidence: 0.65,
          minTrackingConfidence: 0.65
        });

        poseInstance.onResults((results) => this.handlePoseResults(results));
      } catch (e) {
        console.error('Failed to initialize MediaPipe Pose:', e);
      }
    },

    /**
     * カメラの起動とストリーム接続
     */
    async startCamera() {
      if (!videoElement) return;

      try {
        if (cameraInstance) {
          try { cameraInstance.stop(); } catch(err) {}
        }

        const constraints = {
          video: {
            facingMode: currentFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        videoElement.srcObject = stream;
        videoElement.play();

        // MediaPipe Camera utils または自前ループ
        if (typeof window.Camera !== 'undefined') {
          cameraInstance = new window.Camera(videoElement, {
            onFrame: async () => {
              if (videoElement && poseInstance && isRunning) {
                await poseInstance.send({ image: videoElement });
              }
            },
            width: 1280,
            height: 720
          });
          cameraInstance.start();
        } else {
          // フォールバック: requestAnimationFrame ループ
          isRunning = true;
          this.startManualLoop();
        }

        isRunning = true;
      } catch (e) {
        console.error('Camera start error:', e);
        if (window.AppAudio) {
          window.AppAudio.speak('カメラの起動に失敗しました。カメラ権限を確認してください。');
        }
      }
    },

    /**
     * フォールバック用フレーム送信ループ
     */
    startManualLoop() {
      const sendFrame = async () => {
        if (!isRunning) return;
        if (videoElement && poseInstance && videoElement.readyState >= 2) {
          try {
            await poseInstance.send({ image: videoElement });
          } catch (e) {
            // skip frame
          }
        }
        requestAnimationFrame(sendFrame);
      };
      requestAnimationFrame(sendFrame);
    },

    /**
     * カメラのイン/外切替
     */
    switchCamera() {
      currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
      this.startCamera();
      if (window.AppAudio) window.AppAudio.playTap();
      return currentFacingMode;
    },

    /**
     * テストモードの切替
     */
    setTestMode(mode) {
      currentTestMode = mode;
    },

    stop() {
      isRunning = false;
      if (videoElement && videoElement.srcObject) {
        const tracks = videoElement.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        videoElement.srcObject = null;
      }
    },

    /**
     * ★映像と骨格のズレ解消（object-fit: cover のトリミングオフセット逆算）
     * @param {HTMLVideoElement} video 
     * @param {HTMLCanvasElement} canvas 
     */
    getAspectFitBounds(video, canvas) {
      const vWidth = video.videoWidth || 1280;
      const vHeight = video.videoHeight || 720;
      const cWidth = canvas.width;
      const cHeight = canvas.height;

      const videoRatio = vWidth / vHeight;
      const canvasRatio = cWidth / cHeight;

      let renderW, renderH, offsetX, offsetY;

      if (canvasRatio > videoRatio) {
        renderW = cWidth;
        renderH = cWidth / videoRatio;
        offsetX = 0;
        offsetY = (cHeight - renderH) / 2;
      } else {
        renderW = cHeight * videoRatio;
        renderH = cHeight;
        offsetX = (cWidth - renderW) / 2;
        offsetY = 0;
      }

      return {
        x: offsetX,
        y: offsetY,
        w: renderW,
        h: renderH,
        scaleX: renderW / vWidth,
        scaleY: renderH / vHeight
      };
    },

    /**
     * MediaPipe Pose の結果ハンドリング
     */
    handlePoseResults(results) {
      if (!canvasElement || !canvasCtx) return;

      // キャンバス解像度の同期
      if (canvasElement.width !== canvasElement.clientWidth || canvasElement.height !== canvasElement.clientHeight) {
        canvasElement.width = canvasElement.clientWidth;
        canvasElement.height = canvasElement.clientHeight;
      }

      const cWidth = canvasElement.width;
      const cHeight = canvasElement.height;

      canvasCtx.save();
      canvasCtx.clearRect(0, 0, cWidth, cHeight);

      if (!results.poseLandmarks) {
        canvasCtx.restore();
        if (onTriggerReadyCallback) onTriggerReadyCallback(false, '骨格未検出');
        return;
      }

      const landmarks = results.poseLandmarks;
      const bounds = this.getAspectFitBounds(videoElement, canvasElement);

      // 骨格およびジョイントの描画
      this.drawSkeleton(canvasCtx, landmarks, bounds, currentFacingMode === 'user');

      // 構え・正対判定、幾何計算の実行
      this.evaluatePose(landmarks);

      if (onResultsCallback) {
        onResultsCallback(landmarks, bounds);
      }

      canvasCtx.restore();
    },

    /**
     * ブロスタ風カスタム骨格描画
     */
    drawSkeleton(ctx, landmarks, bounds, isMirror) {
      const CONNECTIONS = [
        [11, 12], [11, 23], [12, 24], [23, 24], // 胴体
        [11, 13], [13, 15], // 左腕
        [12, 14], [14, 16], // 右腕
        [23, 25], [25, 27], // 左脚
        [24, 26], [26, 28]  // 右脚
      ];

      ctx.lineWidth = 4;
      ctx.strokeStyle = '#10b981'; // エメラルドグリーン

      CONNECTIONS.forEach(([i, j]) => {
        const p1 = landmarks[i];
        const p2 = landmarks[j];
        if (p1 && p2 && p1.visibility > 0.5 && p2.visibility > 0.5) {
          const x1 = isMirror ? bounds.x + (1 - p1.x) * bounds.w : bounds.x + p1.x * bounds.w;
          const y1 = bounds.y + p1.y * bounds.h;
          const x2 = isMirror ? bounds.x + (1 - p2.x) * bounds.w : bounds.x + p2.x * bounds.w;
          const y2 = bounds.y + p2.y * bounds.h;

          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      });

      // ジョイントの描画
      landmarks.forEach((p, idx) => {
        if (p && p.visibility > 0.5) {
          const x = isMirror ? bounds.x + (1 - p.x) * bounds.w : bounds.x + p.x * bounds.w;
          const y = bounds.y + p.y * bounds.h;

          ctx.fillStyle = '#facc15'; // ウルトゴールド
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, 2 * Math.PI);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#000000';
          ctx.stroke();
        }
      });
    },

    /**
     * 顔正対 × 構えポーズ判定
     */
    evaluatePose(lm) {
      // 0:鼻, 7:左耳, 8:右耳, 11:左肩, 12:右肩, 15:左手首, 16:右手首, 23:左腰, 24:右腰
      if (!lm[0] || !lm[7] || !lm[8] || !lm[11] || !lm[12]) {
        if (onTriggerReadyCallback) onTriggerReadyCallback(false, '全身をフレームインしてください');
        return;
      }

      // 1. 顔の正対判定 (鼻が左右耳の中央比率 0.35 ~ 0.65 にあるか)
      const earLeftX = lm[7].x;
      const earRightX = lm[8].x;
      const noseX = lm[0].x;
      const minEar = Math.min(earLeftX, earRightX);
      const maxEar = Math.max(earLeftX, earRightX);
      const earSpan = maxEar - minEar;

      let isFaceAligned = true;
      if (earSpan > 0.02) {
        const noseRatio = (noseX - minEar) / earSpan;
        isFaceAligned = (noseRatio >= 0.30 && noseRatio <= 0.70);
      }

      // 2. モード別の構え判定
      let isStanceReady = false;
      let stanceMessage = '構え検知待機';

      if (currentTestMode === 'tab-hip' || currentTestMode === 'tab-shoulder2nd') {
        // 仰向け / 横向き：肩と腰がしっかり認識されているか
        isStanceReady = (lm[11].visibility > 0.6 && lm[12].visibility > 0.6 && lm[23].visibility > 0.6);
        stanceMessage = isStanceReady ? 'スタンバイOK！' : '体全体を映してください';
      } else if (currentTestMode === 'tab-banzai') {
        // バンザイ：両手が頭より上にあるか
        const handsUp = lm[15].y < lm[11].y && lm[16].y < lm[12].y;
        isStanceReady = handsUp;
        stanceMessage = handsUp ? 'バンザイOK！' : '両腕を上に挙げて構えてください';
      } else if (currentTestMode === 'tab-hinge') {
        // ヒンジ：直立姿勢（肩が腰の真上にあるか）
        const isUpright = Math.abs(lm[11].x - lm[23].x) < 0.15;
        isStanceReady = isUpright;
        stanceMessage = isUpright ? '直立スタンバイOK！' : 'カメラに正対して直立してください';
      }

      const overallReady = isFaceAligned && isStanceReady;
      if (onTriggerReadyCallback) {
        onTriggerReadyCallback(overallReady, overallReady ? '発動スタンバイOK！' : stanceMessage);
      }

      // 3. カンニング検知（左右腰の高さ跳ね上がり判定）
      if (lm[23] && lm[24]) {
        const hipDiff = Math.abs(lm[23].y - lm[24].y);
        if (hipDiff > 0.12) {
          if (onCheatAlertCallback) onCheatAlertCallback(true, '骨盤が浮いています！');
        } else {
          if (onCheatAlertCallback) onCheatAlertCallback(false, '');
        }
      }

      // 4. 精密幾何計算の実行
      this.calculateMetrics(lm);
    },

    /**
     * 確定4大テストの精密幾何計算
     */
    calculateMetrics(lm) {
      let mainVal = 0;
      let subVal = 0;

      switch (currentTestMode) {
        case 'tab-hip': {
          // ① 股関節ワイパー: すね（膝25/26〜足首27/28）の傾斜角
          // 左足のすねベクトル
          const kneeL = lm[25], ankleL = lm[27];
          if (kneeL && ankleL && kneeL.visibility > 0.5 && ankleL.visibility > 0.5) {
            const dx = ankleL.x - kneeL.x;
            const dy = ankleL.y - kneeL.y;
            mainVal = Math.round(Math.abs(Math.atan2(dx, dy) * (180 / Math.PI)));
          }
          // 右足のすねベクトル
          const kneeR = lm[26], ankleR = lm[28];
          if (kneeR && ankleR && kneeR.visibility > 0.5 && ankleR.visibility > 0.5) {
            const dx = ankleR.x - kneeR.x;
            const dy = ankleR.y - kneeR.y;
            subVal = Math.round(Math.abs(Math.atan2(dx, dy) * (180 / Math.PI)));
          }
          break;
        }
        case 'tab-banzai': {
          // ② 両腕バンザイ: 体幹軸（肩中点〜腰中点）に対する腕の挙上角
          const shoulderMidX = (lm[11].x + lm[12].x) / 2;
          const shoulderMidY = (lm[11].y + lm[12].y) / 2;
          const hipMidX = (lm[23].x + lm[24].x) / 2;
          const hipMidY = (lm[23].y + lm[24].y) / 2;

          // 左腕角
          if (lm[15] && lm[11]) {
            const vx = lm[15].x - lm[11].x;
            const vy = lm[15].y - lm[11].y;
            mainVal = Math.round(Math.abs(Math.atan2(vy, vx) * (180 / Math.PI)));
          }
          // 右腕角
          if (lm[16] && lm[12]) {
            const vx = lm[16].x - lm[12].x;
            const vy = lm[16].y - lm[12].y;
            subVal = Math.round(Math.abs(Math.atan2(vy, vx) * (180 / Math.PI)));
          }
          break;
        }
        case 'tab-shoulder2nd': {
          // ③ 肩2nd内外旋: 肘（13/14）を起点とした前腕（手首15/16）の挟み角
          if (lm[11] && lm[13] && lm[15]) {
            // 左腕の内外旋
            const shoulder = lm[11], elbow = lm[13], wrist = lm[15];
            const angle = this.calculateAngle(shoulder, elbow, wrist);
            mainVal = Math.round(angle);
          }
          if (lm[12] && lm[14] && lm[16]) {
            // 右腕の内外旋
            const shoulder = lm[12], elbow = lm[14], wrist = lm[16];
            const angle = this.calculateAngle(shoulder, elbow, wrist);
            subVal = Math.round(angle);
          }
          break;
        }
        case 'tab-hinge': {
          // ④ もも裏ヒンジ: 大腿軸（股関節〜膝）と体幹軸（股関節〜肩）の前傾挟み角
          if (lm[11] && lm[23] && lm[25]) {
            const shoulder = lm[11], hip = lm[23], knee = lm[25];
            const angle = this.calculateAngle(shoulder, hip, knee);
            mainVal = Math.round(angle);
          }
          break;
        }
      }

      if (onMetricUpdateCallback) {
        onMetricUpdateCallback(mainVal, subVal);
      }
    },

    /**
     * 3点間の角度計算ヘルパー
     */
    calculateAngle(pA, pB, pC) {
      const ab = { x: pA.x - pB.x, y: pA.y - pB.y };
      const cb = { x: pC.x - pB.x, y: pC.y - pB.y };

      const dot = ab.x * cb.x + ab.y * cb.y;
      const magAB = Math.sqrt(ab.x * ab.x + ab.y * ab.y);
      const magCB = Math.sqrt(cb.x * cb.x + cb.y * cb.y);

      if (magAB === 0 || magCB === 0) return 0;

      let radian = Math.acos(Math.max(-1, Math.min(1, dot / (magAB * magCB))));
      return radian * (180 / Math.PI);
    }
  };

  // グローバル公開
  window.AppEngine = AppEngine;

})();
