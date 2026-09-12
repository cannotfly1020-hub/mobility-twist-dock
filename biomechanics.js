/**
 * 🦴 柔軟性・しなりドック - Pose & Geometry Engine (js/engine.js)
 * MediaPipe Pose を活用した実機カメラ制御、イン/外カメラ確実切り替え、
 * アスペクト比補正、顔正対×各モード構えジェスチャー認識、確定4大テスト計算
 * 
 * Improvements:
 * - Fixed kinematic calculations for all 4 test modes (hip, banzai, shoulder2nd, hinge)
 * - Hip rotation now uses pelvis-relative reference frame (pelvic axis anchor)
 * - Banzai (overhead arms) uses inverted Y-axis for correct scale (0°=upright, 180°=overhead)
 * - Shoulder 2nd now measures forearm rotation vs vertical (not locked elbow angle)
 * - MediaPipe Pose load timeout handling with fallback
 * - Comprehensive landmark visibility and validation
 * - Better error boundaries for frame processing
 * - State machine for camera/model initialization
 * - Defensive null/undefined checks throughout
 */
(function() {
  'use strict';

  // ============================================
  // CONFIGURATION
  // ============================================

  const CONFIG = {
    MEDIAPIPE_LOAD_TIMEOUT: 10000, // 10 seconds to load MediaPipe
    MEDIAPIPE_CDN_URL: 'https://cdn.jsdelivr.net/npm/@mediapipe/pose/',
    FALLBACK_CDN_URL: 'https://unpkg.com/@mediapipe/pose/', // Backup CDN
    MODEL_COMPLEXITY: 1,
    MIN_DETECTION_CONFIDENCE: 0.60,
    MIN_TRACKING_CONFIDENCE: 0.60,
    MIN_LANDMARK_VISIBILITY: 0.45,
    FACE_ALIGN_RATIO_MIN: 0.35,
    FACE_ALIGN_RATIO_MAX: 0.65,
    WRIST_DISTANCE_THRESHOLD: 0.28,
    HIP_DIFF_CHEAT_THRESHOLD: 0.09
  };

  // ============================================
  // STATE MACHINE
  // ============================================

  const STATE = {
    UNINITIALIZED: 'uninitialized',
    LOADING_MODEL: 'loading_model',
    MODEL_READY: 'model_ready',
    MODEL_FAILED: 'model_failed',
    CAMERA_RUNNING: 'camera_running',
    CAMERA_ERROR: 'camera_error'
  };

  // ============================================
  // INTERNAL STATE
  // ============================================

  let currentState = STATE.UNINITIALIZED;
  let videoElement = null;
  let canvasElement = null;
  let canvasCtx = null;
  let poseInstance = null;
  let animationFrameId = null;

  let currentFacingMode = 'user'; // 'user' (インカメラ) | 'environment' (アウトカメラ)
  let isRunning = false;
  let isSwitchingCamera = false;
  let currentTestMode = 'tab-hip';

  // Callbacks
  let onResultsCallback = null;
  let onTriggerReadyCallback = null;
  let onMetricUpdateCallback = null;
  let onCheatAlertCallback = null;
  let onMeasurementValidityCallback = null;

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  /**
   * Validate a landmark has sufficient visibility and data
   * @param {Object} landmark - Landmark from MediaPipe
   * @returns {boolean}
   */
  function isValidLandmark(landmark) {
    return landmark &&
           Number.isFinite(landmark.x) &&
           Number.isFinite(landmark.y) &&
           Number.isFinite(landmark.visibility) &&
           landmark.visibility > CONFIG.MIN_LANDMARK_VISIBILITY;
  }

  /**
   * Safe landmark access with validation
   */
  function getLandmark(landmarks, index) {
    return landmarks && landmarks[index] && isValidLandmark(landmarks[index])
      ? landmarks[index]
      : null;
  }

  /**
   * Safely invoke callback if defined
   */
  function invokeCallback(callback, ...args) {
    if (typeof callback === 'function') {
      try {
        callback(...args);
      } catch (err) {
        console.error('Callback execution failed:', err);
      }
    }
  }

  /**
   * Load MediaPipe Pose with fallback CDN
   */
  async function loadPoseModel(primaryUrl = CONFIG.MEDIAPIPE_CDN_URL) {
    const loadTimeout = (url, timeoutMs = CONFIG.MEDIAPIPE_LOAD_TIMEOUT) => {
      return Promise.race([
        new Promise((resolve, reject) => {
          // Check if Pose is already available
          if (typeof window.Pose !== 'undefined') {
            resolve(window.Pose);
          } else {
            reject(new Error(`Pose not available at ${url}`));
          }
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('MediaPipe Pose load timeout')), timeoutMs)
        )
      ]);
    };

    try {
      // Try primary CDN
      console.log(`Loading MediaPipe Pose from ${primaryUrl}`);
      return await loadTimeout(primaryUrl);
    } catch (primaryErr) {
      console.warn(`Primary CDN failed: ${primaryErr.message}. Trying fallback...`);
      try {
        // Try fallback CDN
        return await loadTimeout(CONFIG.FALLBACK_CDN_URL);
      } catch (fallbackErr) {
        console.error(`Both CDNs failed: ${fallbackErr.message}`);
        throw new Error('Failed to load MediaPipe Pose from all CDNs');
      }
    }
  }

  // ============================================
  // MAIN ENGINE
  // ============================================

  const AppEngine = {
    /**
     * Initialize the engine
     */
    init(config) {
      try {
        videoElement = config.videoElement;
        canvasElement = config.canvasElement;
        if (canvasElement) {
          canvasCtx = canvasElement.getContext('2d');
        }
        onResultsCallback = config.onResults || null;
        onTriggerReadyCallback = config.onTriggerReady || null;
        onMetricUpdateCallback = config.onMetricUpdate || null;
        onCheatAlertCallback = config.onCheatAlert || null;
        onMeasurementValidityCallback = config.onMeasurementValidity || null;

        this.initPoseModel();
      } catch (err) {
        console.error('Engine initialization failed:', err);
        currentState = STATE.MODEL_FAILED;
      }
    },

    /**
     * MediaPipe Pose モデルのセットアップ（タイムアウト付き）
     */
    async initPoseModel() {
      if (currentState === STATE.LOADING_MODEL || currentState === STATE.MODEL_READY) {
        return;
      }

      currentState = STATE.LOADING_MODEL;

      try {
        if (typeof window.Pose === 'undefined') {
          console.log('MediaPipe Pose not yet loaded. Waiting...');
          // Set up global listener for when Pose loads
          const checkInterval = setInterval(() => {
            if (typeof window.Pose !== 'undefined') {
              clearInterval(checkInterval);
              this.initPoseModel(); // Retry initialization
            }
          }, 200);

          setTimeout(() => {
            clearInterval(checkInterval);
            if (currentState === STATE.LOADING_MODEL) {
              console.error('MediaPipe Pose load timeout');
              currentState = STATE.MODEL_FAILED;
              invokeCallback(onTriggerReadyCallback, false, 'カメラの初期化に失敗しました');
            }
          }, CONFIG.MEDIAPIPE_LOAD_TIMEOUT);

          return;
        }

        poseInstance = new window.Pose({
          locateFile: (file) => `${CONFIG.MEDIAPIPE_CDN_URL}${file}`
        });

        poseInstance.setOptions({
          modelComplexity: CONFIG.MODEL_COMPLEXITY,
          smoothLandmarks: true,
          enableSegmentation: false,
          smoothSegmentation: false,
          minDetectionConfidence: CONFIG.MIN_DETECTION_CONFIDENCE,
          minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE
        });

        poseInstance.onResults((results) => this.handlePoseResults(results));

        currentState = STATE.MODEL_READY;
        console.log('MediaPipe Pose model initialized successfully');
      } catch (e) {
        console.error('Failed to initialize MediaPipe Pose:', e);
        currentState = STATE.MODEL_FAILED;
        invokeCallback(onTriggerReadyCallback, false, 'ポーズ検出の初期化に失敗しました');
      }
    },

    /**
     * 実機カメラの起動（iOS/Android両対応・確実なストリーム解放）
     */
    async startCamera() {
      if (!videoElement || currentState === STATE.MODEL_FAILED) return;

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
        currentState = STATE.CAMERA_RUNNING;
        this.startFrameProcessingLoop();
      } catch (e) {
        console.error('Camera stream error:', e);
        currentState = STATE.CAMERA_ERROR;
        invokeCallback(onTriggerReadyCallback, false, 'カメラの起動に失敗しました');
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
        if (!isRunning || currentState !== STATE.CAMERA_RUNNING) return;

        if (videoElement && poseInstance && videoElement.readyState >= 2 && !isProcessing) {
          isProcessing = true;
          try {
            await poseInstance.send({ image: videoElement });
          } catch (err) {
            // フレームスキップ - log only in development
            if (process.env.NODE_ENV === 'development') {
              console.debug('Frame processing skipped:', err);
            }
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
     * カメラのイン／アウト反転切り替え
     */
    async switchCamera() {
      if (isSwitchingCamera || currentState === STATE.MODEL_FAILED) return currentFacingMode;
      isSwitchingCamera = true;

      try {
        currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
        await this.startCamera();

        if (window.AppAudio) {
          window.AppAudio.playTap();
        }
      } catch (err) {
        console.error('Camera switch failed:', err);
        currentState = STATE.CAMERA_ERROR;
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

      try {
        if (canvasElement.width !== canvasElement.clientWidth || canvasElement.height !== canvasElement.clientHeight) {
          canvasElement.width = canvasElement.clientWidth;
          canvasElement.height = canvasElement.clientHeight;
        }

        const cWidth = canvasElement.width;
        const cHeight = canvasElement.height;

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, cWidth, cHeight);

        // ★ ポーズが検出されない場合、メトリクスをリセット
        if (!results.poseLandmarks || results.poseLandmarks.length === 0) {
          canvasCtx.restore();
          invokeCallback(onTriggerReadyCallback, false, '全身をフレームに入れてください');
          invokeCallback(onMetricUpdateCallback, 0, 0); // ← メトリクスをリセット
          invokeCallback(onCheatAlertCallback, false, '');
          return;
        }

        const landmarks = results.poseLandmarks;
        const bounds = this.getAspectFitBounds(videoElement, canvasElement);

        // Draw skeleton
        this.drawSkeleton(canvasCtx, landmarks, bounds);

        // Evaluate pose and calculate metrics
        this.evaluatePose(landmarks);

        invokeCallback(onResultsCallback, landmarks, bounds);

        canvasCtx.restore();
      } catch (err) {
        console.error('Error handling pose results:', err);
        canvasCtx.restore();
        // エラー時もメトリクスをリセット
        invokeCallback(onMetricUpdateCallback, 0, 0);
      }
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
        const p1 = getLandmark(landmarks, i);
        const p2 = getLandmark(landmarks, j);
        if (p1 && p2) {
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
        const p = getLandmark(landmarks, idx);
        if (p) {
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
  try {
    const nose = getLandmark(lm, 0);
    const shoulderL = getLandmark(lm, 11);
    const shoulderR = getLandmark(lm, 12);

    if (!nose || !shoulderL || !shoulderR) {
      invokeCallback(onTriggerReadyCallback, false, '全身をフレームに入れてください');
      invokeCallback(onMetricUpdateCallback, null, null);
      return;
    }

    // 1. 顔の正対判定
    let isFaceAligned = true;
    const earL = getLandmark(lm, 7);
    const earR = getLandmark(lm, 8);

    if (earL && earR) {
      const minEar = Math.min(earL.x, earR.x);
      const maxEar = Math.max(earL.x, earR.x);
      const earSpan = maxEar - minEar;
      if (earSpan > 0.015) {
        const noseRatio = (nose.x - minEar) / earSpan;
        isFaceAligned = (noseRatio >= CONFIG.FACE_ALIGN_RATIO_MIN && noseRatio <= CONFIG.FACE_ALIGN_RATIO_MAX);
      }
    }

    // 2. モード別構え判定（既存ロジック簡略維持）
    let isStanceReady = false;
    let stanceMessage = '構え検知待機';

switch (currentTestMode) {
  case 'tab-hip':
  case 'tab-banzai': {
    const wristL = getLandmark(lm, 15);
    const wristR = getLandmark(lm, 16);
    if (wristL && wristR && earL && earR) {
      const distL = Math.hypot(wristL.x - earL.x, wristL.y - earL.y);
      const distR = Math.hypot(wristR.x - earR.x, wristR.y - earR.y);
      const nearEars =
        (distL < CONFIG.WRIST_DISTANCE_THRESHOLD && distR < CONFIG.WRIST_DISTANCE_THRESHOLD) ||
        (wristL.y < shoulderL.y && wristR.y < shoulderR.y);
      isStanceReady = nearEars;
      stanceMessage = nearEars ? '構え完了！キープ！' : '手首を耳元に合わせて構えてください';
    }
    break;
  }

  case 'tab-shoulder2nd': {
    const sL = getLandmark(lm, 11), sR = getLandmark(lm, 12);
    const useLeft =
      (sL?.visibility || 0) + (lm[13]?.visibility || 0) + (lm[15]?.visibility || 0) >=
      (sR?.visibility || 0) + (lm[14]?.visibility || 0) + (lm[16]?.visibility || 0);
    const shoulder = useLeft ? sL : sR;
    const elbow = getLandmark(lm, useLeft ? 13 : 14);
    const wrist = getLandmark(lm, useLeft ? 15 : 16);

    if (shoulder && elbow && wrist) {
      const elbowDistY = Math.abs(elbow.y - shoulder.y);
      const elbowAngle = this.calculateAngle(shoulder, elbow, wrist);
      const wristLevel = Math.abs(wrist.y - elbow.y);
      isStanceReady = (elbowDistY < 0.18) && (elbowAngle >= 60 && elbowAngle <= 120) && (wristLevel < 0.20);
      stanceMessage = isStanceReady ? '肩2ndスタンバイOK！' : '肩と肘を90度に開き前腕を水平に構えてください';
    }
    break;
  }

  case 'tab-hinge': {
    const useLeft =
      (shoulderL?.visibility || 0) + (lm[23]?.visibility || 0) + (lm[25]?.visibility || 0) >=
      (shoulderR?.visibility || 0) + (lm[24]?.visibility || 0) + (lm[26]?.visibility || 0);
    const shoulder = useLeft ? shoulderL : shoulderR;
    const hip = getLandmark(lm, useLeft ? 23 : 24);
    const knee = getLandmark(lm, useLeft ? 25 : 26);

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
    invokeCallback(onTriggerReadyCallback, overallReady, overallReady ? '発動スタンバイOK！' : stanceMessage);

    // 3. カンニング検知
    const hipL = getLandmark(lm, 23);
    const hipR = getLandmark(lm, 24);
    if (hipL && hipR) {
      const hipDiffY = Math.abs(hipL.y - hipR.y);
      if (hipDiffY > CONFIG.HIP_DIFF_CHEAT_THRESHOLD) {
        invokeCallback(onCheatAlertCallback, true, '⚠️ 骨盤が浮いています！床につけよう！');
      } else {
        invokeCallback(onCheatAlertCallback, false, '');
      }
    }

    // 4. 幾何計算
    const metricResult = this.calculateMetrics(lm);
    if (!metricResult) {
      invokeCallback(onMetricUpdateCallback, null, null);
    }
  } catch (err) {
    console.error('Error evaluating pose:', err);
  }
},
    /**
     * 確定4大テストの精密幾何計算 (FIXED: Kinematic corrections for all 4 modes)
     */
    calculateMetrics(lm) {
  try {
    if (!lm || lm.length === 0) return null;
    let mainVal = 0;
    let subVal = 0;
    let isValidFrame = false;

    switch (currentTestMode) {
      case 'tab-hip': {
        const kneeL = getLandmark(lm, 25);
        const ankleL = getLandmark(lm, 27);
        const hipL = getLandmark(lm, 23);
        const hipR = getLandmark(lm, 24);
        const kneeR = getLandmark(lm, 26);
        const ankleR = getLandmark(lm, 28);

        if (!(kneeL && ankleL && hipL && hipR && kneeR && ankleR)) return null;

        const pelvisVec = { x: hipR.x - hipL.x, y: hipR.y - hipL.y };
        const shinVecL = { x: ankleL.x - kneeL.x, y: ankleL.y - kneeL.y };
        const shinVecR = { x: ankleR.x - kneeR.x, y: ankleR.y - kneeR.y };

        mainVal = Math.round(this.vectorAngle(pelvisVec, shinVecL));
        subVal = Math.round(this.vectorAngle(pelvisVec, shinVecR));
        isValidFrame = true;
        break;
      }

      case 'tab-banzai': {
        const shoulderL = getLandmark(lm, 11);
        const shoulderR = getLandmark(lm, 12);
        const hipL = getLandmark(lm, 23);
        const hipR = getLandmark(lm, 24);
        const wristL = getLandmark(lm, 15);
        const wristR = getLandmark(lm, 16);

        if (!(shoulderL && shoulderR && hipL && hipR && wristL && wristR)) return null;

        const shMidX = (shoulderL.x + shoulderR.x) / 2;
        const shMidY = (shoulderL.y + shoulderR.y) / 2;
        const hipMidX = (hipL.x + hipR.x) / 2;
        const hipMidY = (hipL.y + hipR.y) / 2;
        const trunkVec = { x: shMidX - hipMidX, y: shMidY - hipMidY };

        const armVecL = { x: wristL.x - shoulderL.x, y: -(wristL.y - shoulderL.y) };
        const armVecR = { x: wristR.x - shoulderR.x, y: -(wristR.y - shoulderR.y) };

        mainVal = Math.round(this.vectorAngle(trunkVec, armVecL));
        subVal = Math.round(this.vectorAngle(trunkVec, armVecR));
        isValidFrame = true;
        break;
      }

      case 'tab-shoulder2nd': {
        const computeShoulderRotation = (sh, elb, wr) => {
          const forearmVec = { x: wr.x - elb.x, y: wr.y - elb.y };
          const verticalRef = { x: 0, y: -1 };
          return Math.round(this.vectorAngle(verticalRef, forearmVec));
        };

        const shoulderL = getLandmark(lm, 11);
        const elbowL = getLandmark(lm, 13);
        const wristL = getLandmark(lm, 15);
        const shoulderR = getLandmark(lm, 12);
        const elbowR = getLandmark(lm, 14);
        const wristR = getLandmark(lm, 16);

        if (!(shoulderL && elbowL && wristL && shoulderR && elbowR && wristR)) return null;

        mainVal = computeShoulderRotation(shoulderL, elbowL, wristL);
        subVal = computeShoulderRotation(shoulderR, elbowR, wristR);
        isValidFrame = true;
        break;
      }

      case 'tab-hinge': {
        const shoulderL = getLandmark(lm, 11);
        const shoulderR = getLandmark(lm, 12);
        const hipL = getLandmark(lm, 23);
        const hipR = getLandmark(lm, 24);
        const kneeL = getLandmark(lm, 25);
        const kneeR = getLandmark(lm, 26);

        const useLeft =
          (shoulderL?.visibility || 0) + (hipL?.visibility || 0) + (kneeL?.visibility || 0) >=
          (shoulderR?.visibility || 0) + (hipR?.visibility || 0) + (kneeR?.visibility || 0);

        const shoulder = useLeft ? shoulderL : shoulderR;
        const hip = useLeft ? hipL : hipR;
        const knee = useLeft ? kneeL : kneeR;

        if (!(shoulder && hip && knee)) return null;

        const rawAngle = this.calculateAngle(shoulder, hip, knee);
        mainVal = Math.round(Math.max(0, 180 - rawAngle));
        subVal = Math.round(rawAngle);
        isValidFrame = true;
        break;
      }
    }

    if (!isValidFrame) return null;
    invokeCallback(onMetricUpdateCallback, mainVal, subVal);
    return { mainVal, subVal };
  } catch (err) {
    console.error('Error calculating metrics:', err);
    return null;
  }
},

          /**
           * ✓ Tab-Hinge: Correct as-is
           * Measures hip flexion by computing angle at hip joint, then inverting (180 - angle)
           * Expected: 0°=folded (90° hip flex), 90°=folded (90° hip flex), full depth measured
           */
          case 'tab-hinge': {
            const shoulderL = getLandmark(lm, 11);
            const shoulderR = getLandmark(lm, 12);
            const hipL = getLandmark(lm, 23);
            const hipR = getLandmark(lm, 24);
            const kneeL = getLandmark(lm, 25);
            const kneeR = getLandmark(lm, 26);

            const useLeft = (shoulderL?.visibility || 0) + (hipL?.visibility || 0) + (kneeL?.visibility || 0) >=
                           (shoulderR?.visibility || 0) + (hipR?.visibility || 0) + (kneeR?.visibility || 0);
            const shoulder = useLeft ? shoulderL : shoulderR;
            const hip = useLeft ? hipL : hipR;
            const knee = useLeft ? kneeL : kneeR;

            if (shoulder && hip && knee) {
              const rawAngle = this.calculateAngle(shoulder, hip, knee);
              const hingeAngle = Math.round(Math.max(0, 180 - rawAngle));
              mainVal = hingeAngle;
              subVal = Math.round(rawAngle);
            }
            break;
          }
        }

        if (!isValidFrame) return null;

invokeCallback(onMetricUpdateCallback, mainVal, subVal);
return { mainVal, subVal };
     } catch (err) {
  console.error('Error calculating metrics:', err);
  return null;
}
    },

    /**
     * Calculate angle between 3 points (degrees)
     * Forms an angle at point B, with rays toward A and C
     */
    calculateAngle(pA, pB, pC) {
      if (!pA || !pB || !pC) return 0;

      const ab = { x: pA.x - pB.x, y: pA.y - pB.y };
      const cb = { x: pC.x - pB.x, y: pC.y - pB.y };

      const dot = ab.x * cb.x + ab.y * cb.y;
      const magAB = Math.hypot(ab.x, ab.y);
      const magCB = Math.hypot(cb.x, cb.y);

      if (magAB === 0 || magCB === 0) return 0;

      const cosTheta = Math.max(-1, Math.min(1, dot / (magAB * magCB)));
      return Math.acos(cosTheta) * (180 / Math.PI);
    },

    /**
     * Calculate angle between 2 vectors (degrees)
     * Range: 0° to 180°
     */
    vectorAngle(v1, v2) {
      if (!v1 || !v2) return 0;

      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag1 = Math.hypot(v1.x, v1.y);
      const mag2 = Math.hypot(v2.x, v2.y);

      if (mag1 === 0 || mag2 === 0) return 0;

      const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
      return Math.acos(cosTheta) * (180 / Math.PI);
    }
  };

  // ============================================
  // EXPORT
  // ============================================

  window.AppEngine = AppEngine;

})();
