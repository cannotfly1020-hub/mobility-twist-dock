/**
 * 🦴 柔軟性・しなりドック - Pose & Geometry Engine (js/engine.js)
 * MediaPipe Pose を活用した実機カメラ制御、イン/外カメラ確実切り替え、
 * アスペクト比補正、顔正対×各モード構えジェスチャー認識、確定4大テスト計算
 */
(function() {
  'use strict';

  // 内部状態変数
  let videoElement = null;
  let canvasElement = null;
  let canvasCtx = null;
  let poseInstance = null;
  let animationFrameId = null;

  let currentFacingMode = 'user'; // 'user' (インカメラ) | 'environment' (アウトカメラ)
  let isRunning = false;
  let isSwitchingCamera = false;
  let currentTestMode = 'tab-hip';

  // コールバック関数群
  let onResultsCallback = null;
  let onTriggerReadyCallback = null;
  let onMetricUpdateCallback = null;
  let onCheatAlertCallback = null;

  const AppEngine = {
    /**
     * エンジンの初期化
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
        setTimeout(() => this.initPoseModel(), 300);
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
          minDetectionConfidence: 0.60,
          minTrackingConfidence: 0.60
        });

        poseInstance.onResults((results) => this.handlePoseResults(results));
      } catch (e) {
        console.error('Failed to initialize MediaPipe Pose:', e);
      }
    },

    /**
     * 実機カメラの起動（iOS/Android両対応・確実なストリーム解放）
     */
    async startCamera() {
      if (!videoElement) return;

      try {
        // 既存のストリームを完全に停止・破棄
        this.stopCameraStream();

        // スマホでのカメラ切り替えの安定化のため微小待機
        await new Promise(resolve => setTimeout(resolve, 80));

        // exact -> ideal の順でフォールバックしてカメラを取得
        let stream = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { exact: currentFacingMode },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          });
        } catch (exactErr) {
          // exactが使えない端末（PCブラウザ等）用のフォールバック
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: currentFacingMode,
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          });
        }

        videoElement.srcObject = stream;
        videoElement.setAttribute('playsinline', 'true');
        videoElement.setAttribute('webkit-playsinline', 'true');
        videoElement.muted = true;
        
        await videoElement.play();

        isRunning = true;
        // 競合を防ぐため、MediaPipe Camera utils に依存せず自前フレームループを実行
        this.startFrameProcessingLoop();

      } catch (e) {
        console.error('Camera stream error:', e);
        if (window.AppAudio) {
          window.AppAudio.speak('カメラの起動に失敗しました。アクセスを許可してください');
        }
      }
    },

    /**
     * 高精度フレーム送信ループ
     */
    startFrameProcessingLoop() {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      let isProcessing = false;

      const processFrame = async () => {
        if (!isRunning) return;

        if (videoElement && poseInstance && videoElement.readyState >= 2 && !isProcessing) {
          isProcessing = true;
          try {
            await poseInstance.send({ image: videoElement });
          } catch (err) {
            // フレームスキップ
          } finally {
            isProcessing = false;
          }
        }

        if (isRunning) {
          animationFrameId = requestAnimationFrame(processFrame);
        }
      };

      animationFrameId = requestAnimationFrame(processFrame);
    },

    /**
     * カメラのイン／アウト反転切り替え（非同期で安全に実行）
     */
    async switchCamera() {
      if (isSwitchingCamera) return currentFacingMode;
      isSwitchingCamera = true;

      try {
        currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
        await this.startCamera();

        if (window.AppAudio) {
          window.AppAudio.playTap();
        }
      } catch (err) {
        console.error('Camera switch failed:', err);
      } finally {
        isSwitchingCamera = false;
      }

      return currentFacingMode;
    },

    getFacingMode() {
      return currentFacingMode;
    },

    setTestMode(mode) {
      currentTestMode = mode;
    },

    /**
     * ストリームの完全停止
     */
    stopCameraStream() {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      if (videoElement && videoElement.srcObject) {
        const stream = videoElement.srcObject;
        const tracks = stream.getTracks();
        tracks.forEach(track => {
          track.stop();
          stream.removeTrack(track);
        });
        videoElement.srcObject = null;
      }
    },

    stop() {
      isRunning = false;
      this.stopCameraStream();
    },

    /**
     * ★映像と骨格のズレ解消（object-fit: cover による切り捨てオフセット逆算）
     */
    getAspectFitBounds(video, canvas) {
      const vWidth = video.videoWidth || 1280;
      const vHeight = video.videoHeight || 720;
      const cWidth = canvas.width || canvas.clientWidth || 1;
      const cHeight = canvas.height || canvas.clientHeight || 1;

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
        h: renderH
      };
    },

    /**
     * MediaPipe Pose 推定フレームの受領と処理
     */
    handlePoseResults(results) {
      if (!canvasElement || !canvasCtx) return;

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
        if (onTriggerReadyCallback) onTriggerReadyCallback(false, '全身をフレームに入れてください');
        return;
      }

      const landmarks = results.poseLandmarks;
      const bounds = this.getAspectFitBounds(videoElement, canvasElement);

      // ビデオとキャンバスの両方に同じCSS Transform (scaleX(-1)) を適用するため、
      // 描画内部での座標反転は行わず、そのまま bounds に合わせてレンダリングします
      this.drawSkeleton(canvasCtx, landmarks, bounds);

      // 顔正対・構えポーズ・代償動作判定
      this.evaluatePose(landmarks);

      if (onResultsCallback) {
        onResultsCallback(landmarks, bounds);
      }

      canvasCtx.restore();
    },

    /**
     * 骨格線とジョイントの描画
     */
    drawSkeleton(ctx, landmarks, bounds) {
      const CONNECTIONS = [
        [11, 12], [11, 23], [12, 24], [23, 24], // 胴体
        [11, 13], [13, 15],                     // 左腕
        [12, 14], [14, 16],                     // 右腕
        [23, 25], [25, 27],                     // 左脚
        [24, 26], [26, 28]                      // 右脚
      ];

      ctx.lineWidth = 4;
      ctx.strokeStyle = '#10b981'; // エメラルドグリーン
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      CONNECTIONS.forEach(([i, j]) => {
        const p1 = landmarks[i];
        const p2 = landmarks[j];
        if (p1 && p2 && p1.visibility > 0.45 && p2.visibility > 0.45) {
          const x1 = bounds.x + p1.x * bounds.w;
          const y1 = bounds.y + p1.y * bounds.h;
          const x2 = bounds.x + p2.x * bounds.w;
          const y2 = bounds.y + p2.y * bounds.h;

          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      });

      const KEY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
      KEY_JOINTS.forEach((idx) => {
        const p = landmarks[idx];
        if (p && p.visibility > 0.45) {
          const x = bounds.x + p.x * bounds.w;
          const y = bounds.y + p.y * bounds.h;

          ctx.beginPath();
          ctx.arc(x, y, 6, 0, 2 * Math.PI);
          ctx.fillStyle = '#0f172a';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
          ctx.fillStyle = '#facc15';
          ctx.fill();
        }
      });
    },

    /**
     * 【顔正対 × 構えジェスチャー】スタート判定 ＆ カンニング検知
     */
    evaluatePose(lm) {
      if (!lm[0] || !lm[11] || !lm[12]) {
        if (onTriggerReadyCallback) onTriggerReadyCallback(false, '全身をフレームに入れてください');
        return;
      }

      // 1. 顔の正対判定 (鼻が左右耳の中央比率 0.35〜0.65 にあるか)
      let isFaceAligned = true;
      if (lm[7] && lm[8] && lm[7].visibility > 0.4 && lm[8].visibility > 0.4) {
        const earLeftX = lm[7].x;
        const earRightX = lm[8].x;
        const noseX = lm[0].x;
        const minEar = Math.min(earLeftX, earRightX);
        const maxEar = Math.max(earLeftX, earRightX);
        const earSpan = maxEar - minEar;

        if (earSpan > 0.015) {
          const noseRatio = (noseX - minEar) / earSpan;
          isFaceAligned = (noseRatio >= 0.35 && noseRatio <= 0.65);
        }
      }

      // 2. モード別の構えジェスチャー認識
      let isStanceReady = false;
      let stanceMessage = '構え検知待機';

      switch (currentTestMode) {
        case 'tab-hip':
        case 'tab-banzai': {
          const earL = lm[7] || lm[11];
          const earR = lm[8] || lm[12];
          const wristL = lm[15];
          const wristR = lm[16];

          if (wristL && wristR && earL && earR) {
            const distL = Math.hypot(wristL.x - earL.x, wristL.y - earL.y);
            const distR = Math.hypot(wristR.x - earR.x, wristR.y - earR.y);
            const nearEars = (distL < 0.28 && distR < 0.28) || (wristL.y < lm[11].y && wristR.y < lm[12].y);
            isStanceReady = nearEars;
            stanceMessage = nearEars ? '構え完了！キープ！' : '手首を耳元に合わせて構えてください';
          }
          break;
        }

        case 'tab-shoulder2nd': {
          const useLeft = (lm[11].visibility + lm[13].visibility + lm[15].visibility) >=
                          (lm[12].visibility + lm[14].visibility + lm[16].visibility);
          const shoulder = useLeft ? lm[11] : lm[12];
          const elbow = useLeft ? lm[13] : lm[14];
          const wrist = useLeft ? lm[15] : lm[16];

          if (shoulder && elbow && wrist) {
            const elbowDistY = Math.abs(elbow.y - shoulder.y);
            const elbowAngle = this.calculateAngle(shoulder, elbow, wrist);
            const wristLevel = Math.abs(wrist.y - elbow.y);

            const isAbducted = elbowDistY < 0.18;
            const is90DegFlex = (elbowAngle >= 60 && elbowAngle <= 120);
            const isForearmHorizontal = wristLevel < 0.20;

            isStanceReady = isAbducted && is90DegFlex && isForearmHorizontal;
            stanceMessage = isStanceReady ? '肩2ndスタンバイOK！' : '肩と肘を90度に開き前腕を水平に構えてください';
          }
          break;
        }

        case 'tab-hinge': {
          const useLeft = (lm[11].visibility + lm[23].visibility) >= (lm[12].visibility + lm[24].visibility);
          const shoulder = useLeft ? lm[11] : lm[12];
          const hip = useLeft ? lm[23] : lm[24];
          const knee = useLeft ? lm[25] : lm[26];

          if (shoulder && hip && knee) {
            const trunkVertical = Math.abs(shoulder.x - hip.x) < 0.15;
            const legStraight = this.calculateAngle(shoulder, hip, knee) >= 150;

            isStanceReady = trunkVertical && legStraight;
            stanceMessage = isStanceReady ? '直立スタンバイOK！' : '横を向いて背筋を伸ばし直立してください';
          }
          break;
        }
      }

      const overallReady = isFaceAligned && isStanceReady;
      if (onTriggerReadyCallback) {
        onTriggerReadyCallback(overallReady, overallReady ? '発動スタンバイOK！' : stanceMessage);
      }

      // 3. カンニング検知（骨盤浮き判定）
      if (lm[23] && lm[24] && lm[23].visibility > 0.45 && lm[24].visibility > 0.45) {
        const hipDiffY = Math.abs(lm[23].y - lm[24].y);
        if (hipDiffY > 0.09) {
          if (onCheatAlertCallback) onCheatAlertCallback(true, '⚠️ 骨盤が浮いています！床につけよう！');
        } else {
          if (onCheatAlertCallback) onCheatAlertCallback(false, '');
        }
      }

      // 4. 幾何計算
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
          const kneeL = lm[25], ankleL = lm[27];
          if (kneeL && ankleL && kneeL.visibility > 0.4 && ankleL.visibility > 0.4) {
            const dx = ankleL.x - kneeL.x;
            const dy = ankleL.y - kneeL.y;
            mainVal = Math.round(Math.abs(Math.atan2(dx, dy) * (180 / Math.PI)));
          }

          const kneeR = lm[26], ankleR = lm[28];
          if (kneeR && ankleR && kneeR.visibility > 0.4 && ankleR.visibility > 0.4) {
            const dx = ankleR.x - kneeR.x;
            const dy = ankleR.y - kneeR.y;
            subVal = Math.round(Math.abs(Math.atan2(dx, dy) * (180 / Math.PI)));
          }
          break;
        }

        case 'tab-banzai': {
          const shMidX = (lm[11].x + lm[12].x) / 2;
          const shMidY = (lm[11].y + lm[12].y) / 2;
          const hipMidX = (lm[23].x + lm[24].x) / 2;
          const hipMidY = (lm[23].y + lm[24].y) / 2;

          const trunkVec = { x: shMidX - hipMidX, y: shMidY - hipMidY };

          if (lm[11] && lm[15] && lm[11].visibility > 0.4 && lm[15].visibility > 0.4) {
            const armVecL = { x: lm[15].x - lm[11].x, y: lm[15].y - lm[11].y };
            mainVal = Math.round(this.vectorAngle(trunkVec, armVecL));
          }

          if (lm[12] && lm[16] && lm[12].visibility > 0.4 && lm[16].visibility > 0.4) {
            const armVecR = { x: lm[16].x - lm[12].x, y: lm[16].y - lm[12].y };
            subVal = Math.round(this.vectorAngle(trunkVec, armVecR));
          }
          break;
        }

        case 'tab-shoulder2nd': {
          const computeShoulderRotation = (sh, elb, wr) => {
            if (!sh || !elb || !wr) return 0;
            return Math.round(this.calculateAngle(sh, elb, wr));
          };

          if (lm[11] && lm[13] && lm[15]) {
            mainVal = computeShoulderRotation(lm[11], lm[13], lm[15]);
          }
          if (lm[12] && lm[14] && lm[16]) {
            subVal = computeShoulderRotation(lm[12], lm[14], lm[16]);
          }
          break;
        }

        case 'tab-hinge': {
          const useLeft = (lm[11].visibility + lm[23].visibility + lm[25].visibility) >=
                          (lm[12].visibility + lm[24].visibility + lm[26].visibility);
          const shoulder = useLeft ? lm[11] : lm[12];
          const hip = useLeft ? lm[23] : lm[24];
          const knee = useLeft ? lm[25] : lm[26];

          if (shoulder && hip && knee && hip.visibility > 0.4) {
            const rawAngle = this.calculateAngle(shoulder, hip, knee);
            const hingeAngle = Math.round(Math.max(0, 180 - rawAngle));
            mainVal = hingeAngle;
            subVal = Math.round(rawAngle);
          }
          break;
        }
      }

      if (onMetricUpdateCallback) {
        onMetricUpdateCallback(mainVal, subVal);
      }
    },

    calculateAngle(pA, pB, pC) {
      const ab = { x: pA.x - pB.x, y: pA.y - pB.y };
      const cb = { x: pC.x - pB.x, y: pC.y - pB.y };

      const dot = ab.x * cb.x + ab.y * cb.y;
      const magAB = Math.hypot(ab.x, ab.y);
      const magCB = Math.hypot(cb.x, cb.y);

      if (magAB === 0 || magCB === 0) return 0;

      const cosTheta = Math.max(-1, Math.min(1, dot / (magAB * magCB)));
      return Math.acos(cosTheta) * (180 / Math.PI);
    },

    vectorAngle(v1, v2) {
      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag1 = Math.hypot(v1.x, v1.y);
      const mag2 = Math.hypot(v2.x, v2.y);

      if (mag1 === 0 || mag2 === 0) return 0;

      const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
      return Math.acos(cosTheta) * (180 / Math.PI);
    }
  };

  window.AppEngine = AppEngine;

})();
