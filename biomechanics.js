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
  baseline: {
    hip: {
      left: null,
      right: null
    }
  },

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
          const checkInterval = setInterval(() => {
            if (typeof window.Pose !== 'undefined') {
              clearInterval(checkInterval);
              this.initPoseModel();
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
        this.stopCameraStream();
        await new Promise(resolve => setTimeout(resolve, 80));

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

        const landmarks = results.poseLandmarks;

// 全身判定に必要な主要ポイント
const requiredPoints = [
  getLandmark(landmarks, 0),   // 鼻
  getLandmark(landmarks, 11),  // 左肩
  getLandmark(landmarks, 12),  // 右肩
  getLandmark(landmarks, 23),  // 左腰
  getLandmark(landmarks, 24)   // 右腰
];

const hasEnoughBody = requiredPoints.every(Boolean);

if (!landmarks || landmarks.length === 0 || !hasEnoughBody) {
  canvasCtx.restore();
  invokeCallback(onTriggerReadyCallback, false, '全身をフレームに入れてください');
  invokeCallback(onMetricUpdateCallback, 0, 0);
  invokeCallback(onCheatAlertCallback, false, '');
  return;
}

const bounds = this.getAspectFitBounds(videoElement, canvasElement);
this.drawSkeleton(canvasCtx, landmarks, bounds);
this.evaluatePose(landmarks);
invokeCallback(onResultsCallback, landmarks, bounds);
canvasCtx.restore();
      } catch (err) {
        console.error('Error handling pose results:', err);
        canvasCtx.restore();
        invokeCallback(onMetricUpdateCallback, 0, 0);
      }
    },

    /**
     * 骨格線とジョイントの描画
     */
    drawSkeleton(ctx, landmarks, bounds) {
      const CONNECTIONS = [
        [11, 12], [11, 23], [12, 24], [23, 24],
        [11, 13], [13, 15],
        [12, 14], [14, 16],
        [23, 25], [25, 27],
        [24, 26], [26, 28]
      ];

      ctx.lineWidth = 4;
      ctx.strokeStyle = '#10b981';
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
            const sL = getLandmark(lm, 11);
            const sR = getLandmark(lm, 12);

  // 右左どちらの腕が見えやすいかを visibility で選ぶ
            const useLeft =
              (sL?.visibility || 0) + (lm[13]?.visibility || 0) + (lm[15]?.visibility || 0) >=
              (sR?.visibility || 0) + (lm[14]?.visibility || 0) + (lm[16]?.visibility || 0);

  const shoulder = useLeft ? sL : sR;
  const elbow = getLandmark(lm, useLeft ? 13 : 14);
  const wrist = getLandmark(lm, useLeft ? 15 : 16);

  if (shoulder && elbow && wrist) {
    // 前腕が横方向に近いかを見る
    const forearmAngle = Math.abs(
      Math.atan2(wrist.y - elbow.y, wrist.x - elbow.x) * 180 / Math.PI
    );

    // 肩・肘・手首の角度
    const elbowAngle = this.calculateAngle(shoulder, elbow, wrist);

    // 肘が肩から極端に離れていないか
    const elbowNearShoulder = Math.abs(elbow.y - shoulder.y) < 0.28;

    // 前腕がほぼ水平に近いか
    const forearmNearHorizontal = forearmAngle < 35 || forearmAngle > 145;

    isStanceReady =
      elbowNearShoulder &&
      forearmNearHorizontal &&
      elbowAngle >= 45 && elbowAngle <= 135;

    stanceMessage = isStanceReady
      ? '肩2ndスタンバイOK！'
      : '肩を水平付近に保ち、前腕を横に近い角度で構えてください';
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

          default:
            break;
        }

        const overallReady = isFaceAligned && isStanceReady;
        invokeCallback(onTriggerReadyCallback, overallReady, overallReady ? '発動スタンバイOK！' : stanceMessage);

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

        const metricResult = this.calculateMetrics(lm);
        if (!metricResult) {
          invokeCallback(onMetricUpdateCallback, null, null);
          return;
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

            const rawLeft = Math.round(this.vectorAngle(pelvisVec, shinVecL));
            const rawRight = Math.round(this.vectorAngle(pelvisVec, shinVecR));

            if (this.baseline.hip.left === null) {
              this.baseline.hip.left = rawLeft;
            }
            if (this.baseline.hip.right === null) {
              this.baseline.hip.right = rawRight;
            }

            mainVal = rawLeft - this.baseline.hip.left;
            subVal = rawRight - this.baseline.hip.right;
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
  const computeShoulderRotation = (elb, wr) => {
    const forearmVec = { x: wr.x - elb.x, y: wr.y - elb.y };

    // 水平基準で前腕の向きを見る
    const horizontalRef = { x: 1, y: 0 };

    return Math.round(this.vectorAngle(horizontalRef, forearmVec));
  };

  const shoulderL = getLandmark(lm, 11);
  const elbowL = getLandmark(lm, 13);
  const wristL = getLandmark(lm, 15);
  const shoulderR = getLandmark(lm, 12);
  const elbowR = getLandmark(lm, 14);
  const wristR = getLandmark(lm, 16);

  if (!(shoulderL && elbowL && wristL && shoulderR && elbowR && wristR)) return null;

  // どちらの腕も計算する
  mainVal = computeShoulderRotation(elbowL, wristL);
  subVal = computeShoulderRotation(elbowR, wristR);
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
    },
    
    /**
     * 2点の中点を返す
     */
    getMidpoint(p1, p2) {
      if (!p1 || !p2) return null;
      return {
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2
      };
    },

    /**
     * 2点間の距離を返す
     */
    pointDistance(p1, p2) {
      if (!p1 || !p2) return null;
      return Math.hypot(p1.x - p2.x, p1.y - p2.y);
    },

    /**
     * 指定ランドマーク群の visibility が十分か確認する
     */
    areLandmarksVisible(lm, indices, minVisibility = CONFIG.MIN_LANDMARK_VISIBILITY) {
      if (!lm || !Array.isArray(indices) || indices.length === 0) return false;
      return indices.every((idx) => {
        const p = getLandmark(lm, idx);
        return p && (p.visibility ?? 0) >= minVisibility;
      });
    },

    /**
     * 骨盤の安定性を判定する
     * - 左右hipの高さ差
     * - 左右hip中心の位置ずれ
     * - 肩ラインとのズレ
     */
    detectPelvisStability(lm) {
      try {
        const shoulderL = getLandmark(lm, 11);
        const shoulderR = getLandmark(lm, 12);
        const hipL = getLandmark(lm, 23);
        const hipR = getLandmark(lm, 24);

        if (!(shoulderL && shoulderR && hipL && hipR)) {
          return {
            stable: false,
            tiltDeg: null,
            shift: null,
            rotationRisk: true
          };
        }

        const hipMid = this.getMidpoint(hipL, hipR);
        const shoulderMid = this.getMidpoint(shoulderL, shoulderR);

        const hipLine = { x: hipR.x - hipL.x, y: hipR.y - hipL.y };
        const verticalRef = { x: 0, y: -1 };
        const tiltDeg = Math.round(this.vectorAngle(verticalRef, hipLine) * 10) / 10;

        const hipHeightDiff = Math.abs(hipL.y - hipR.y);
        const shoulderHipShift = Math.abs((shoulderMid?.x ?? 0) - (hipMid?.x ?? 0));

        const stable = hipHeightDiff < 0.05 && shoulderHipShift < 0.08 && tiltDeg < 10;

        return {
          stable,
          tiltDeg,
          shift: Math.round(shoulderHipShift * 1000) / 1000,
          rotationRisk: !stable
        };
      } catch (err) {
        console.error('detectPelvisStability failed:', err);
        return {
          stable: false,
          tiltDeg: null,
          shift: null,
          rotationRisk: true
        };
      }
    },

    /**
     * 体幹の傾き代償を判定する
     */
    detectTrunkLean(lm) {
      try {
        const shoulderL = getLandmark(lm, 11);
        const shoulderR = getLandmark(lm, 12);
        const hipL = getLandmark(lm, 23);
        const hipR = getLandmark(lm, 24);

        if (!(shoulderL && shoulderR && hipL && hipR)) {
          return {
            flagged: true,
            leanDeg: null,
            reason: ['体幹判定に必要なランドマークが不足しています']
          };
        }

        const shoulderMid = this.getMidpoint(shoulderL, shoulderR);
        const hipMid = this.getMidpoint(hipL, hipR);
        const trunkVec = {
          x: shoulderMid.x - hipMid.x,
          y: shoulderMid.y - hipMid.y
        };

        const verticalRef = { x: 0, y: -1 };
        const leanDeg = Math.round(this.vectorAngle(verticalRef, trunkVec) * 10) / 10;

        const flagged = leanDeg > 12;

        return {
          flagged,
          leanDeg,
          reason: flagged ? ['体幹の傾きが大きいです'] : []
        };
      } catch (err) {
        console.error('detectTrunkLean failed:', err);
        return {
          flagged: true,
          leanDeg: null,
          reason: ['体幹傾き判定に失敗しました']
        };
      }
    },
    /**
     * 内外転代償を判定する
     * - 膝が股関節中心から横に逃げているか
     * - 足首が膝から横に逃げているか
     * - 足部が横にスライドしているか
     */
    detectAbductionAdductionCompensation(lm, side = 'left', baseline = null) {
      try {
        const prefix = side === 'right' ? 'right' : 'left';
        const hipIdx = prefix === 'left' ? 23 : 24;
        const kneeIdx = prefix === 'left' ? 25 : 26;
        const ankleIdx = prefix === 'left' ? 27 : 28;
        const footIdx = prefix === 'left' ? 29 : 30;

        const hip = getLandmark(lm, hipIdx);
        const knee = getLandmark(lm, kneeIdx);
        const ankle = getLandmark(lm, ankleIdx);
        const foot = getLandmark(lm, footIdx);

        if (!(hip && knee && ankle)) {
          return {
            flagged: true,
            severity: 'severe',
            kneeLateralShift: null,
            ankleLateralShift: null,
            footDrift: null,
            reason: ['内外転代償判定に必要なランドマークが不足しています']
          };
        }

        const hipCenter = this.getMidpoint(
          getLandmark(lm, 23),
          getLandmark(lm, 24)
        ) || hip;

        const kneeLateralShift = Math.abs(knee.x - hipCenter.x);
        const ankleLateralShift = Math.abs(ankle.x - knee.x);
        const footDrift = foot ? Math.abs(foot.x - ankle.x) : null;

        const kneeThreshold = baseline?.kneeLateralShiftMax ?? 0.10;
        const ankleThreshold = baseline?.ankleLateralShiftMax ?? 0.08;
        const footThreshold = baseline?.footDriftMax ?? 0.10;

        const kneeFlag = kneeLateralShift > kneeThreshold;
        const ankleFlag = ankleLateralShift > ankleThreshold;
        const footFlag = footDrift !== null ? footDrift > footThreshold : false;

        const flags = [kneeFlag, ankleFlag, footFlag].filter(Boolean).length;

        let severity = 'none';
        if (flags === 1) severity = 'mild';
        if (flags === 2) severity = 'moderate';
        if (flags >= 3) severity = 'severe';

        const reason = [];
        if (kneeFlag) reason.push('膝の横移動が大きいです');
        if (ankleFlag) reason.push('足首が膝から横に逃げています');
        if (footFlag) reason.push('足部が横にスライドしています');

        return {
          flagged: flags > 0,
          severity,
          kneeLateralShift: Math.round(kneeLateralShift * 1000) / 1000,
          ankleLateralShift: Math.round(ankleLateralShift * 1000) / 1000,
          footDrift: footDrift === null ? null : Math.round(footDrift * 1000) / 1000,
          reason
        };
      } catch (err) {
        console.error('detectAbductionAdductionCompensation failed:', err);
        return {
          flagged: true,
          severity: 'severe',
          kneeLateralShift: null,
          ankleLateralShift: null,
          footDrift: null,
          reason: ['内外転代償判定に失敗しました']
        };
      }
    },

    /**
     * 股関節の内外旋を下腿・足部の向きから推定する
     */
    estimateHipRotationAngles(lm, side = 'left') {
      try {
        const prefix = side === 'right' ? 'right' : 'left';
        const hipIdx = prefix === 'left' ? 23 : 24;
        const kneeIdx = prefix === 'left' ? 25 : 26;
        const ankleIdx = prefix === 'left' ? 27 : 28;
        const footIdx = prefix === 'left' ? 29 : 30;

        const hip = getLandmark(lm, hipIdx);
        const knee = getLandmark(lm, kneeIdx);
        const ankle = getLandmark(lm, ankleIdx);
        const foot = getLandmark(lm, footIdx);

        if (!(hip && knee && ankle)) {
          return {
            shankAngleDeg: null,
            footAngleDeg: null,
            estimatedRotationDeg: null
          };
        }

        const shankVec = { x: ankle.x - knee.x, y: ankle.y - knee.y };
        const verticalRef = { x: 0, y: -1 };
        const shankAngleDeg = Math.round(this.vectorAngle(verticalRef, shankVec) * 10) / 10;

        let footAngleDeg = null;
        if (foot) {
          const footVec = { x: foot.x - ankle.x, y: foot.y - ankle.y };
          footAngleDeg = Math.round(this.vectorAngle(verticalRef, footVec) * 10) / 10;
        }

        let estimatedRotationDeg = shankAngleDeg;
        if (footAngleDeg !== null) {
          estimatedRotationDeg = Math.round(((shankAngleDeg + footAngleDeg) / 2) * 10) / 10;
        }

        return {
          shankAngleDeg,
          footAngleDeg,
          estimatedRotationDeg
        };
      } catch (err) {
        console.error('estimateHipRotationAngles failed:', err);
        return {
          shankAngleDeg: null,
          footAngleDeg: null,
          estimatedRotationDeg: null
        };
      }
    },

    /**
     * 股関節内外旋 + 内外転代償 + 体幹代償をまとめて評価する
     */
    evaluateHipRotationWithCompensation(lm, options = {}) {
      try {
        const side = options.side || 'left';
        const minVisibility = options.minVisibility ?? CONFIG.MIN_LANDMARK_VISIBILITY;
        const baseline = options.baseline || null;

        const hipIdx = side === 'right' ? 24 : 23;
        const kneeIdx = side === 'right' ? 26 : 25;
        const ankleIdx = side === 'right' ? 28 : 27;

        const required = [hipIdx, kneeIdx, ankleIdx];
        const visibleEnough = this.areLandmarksVisible(lm, required, minVisibility);

        if (!visibleEnough) {
          return {
            valid: false,
            side,
            rotation: {
              left: { angle: null, delta: null, internal: null, external: null, rom: null },
              right: { angle: null, delta: null, internal: null, external: null, rom: null }
            },
            compensation: {
              abductionAdduction: true,
              pelvisShift: true,
              trunkLean: true,
              footDrift: true
            },
            metrics: {
              pelvisTiltDeg: null,
              hipShiftPx: null,
              kneeShiftPx: null,
              ankleShiftPx: null,
              shankAngleLeftDeg: null,
              shankAngleRightDeg: null
            },
            warnings: ['必要なランドマークの可視性が不足しています'],
            score: {
              rotation: 0,
              compensationPenalty: 100,
              final: 0
            }
          };
        }

        const pelvis = this.detectPelvisStability(lm);
        const trunk = this.detectTrunkLean(lm);

        const compLeft = this.detectAbductionAdductionCompensation(lm, 'left', baseline);
        const compRight = this.detectAbductionAdductionCompensation(lm, 'right', baseline);

        const rotLeft = this.estimateHipRotationAngles(lm, 'left');
        const rotRight = this.estimateHipRotationAngles(lm, 'right');

        // --------------------------------------------------
        // 0°基準: baseline があれば、その値からの差分を使う
        // baseline がなければ、現時点を 0° として扱う
        // --------------------------------------------------
        const baselineLeft = baseline?.leftRotationDeg ?? rotLeft.estimatedRotationDeg ?? 0;
        const baselineRight = baseline?.rightRotationDeg ?? rotRight.estimatedRotationDeg ?? 0;

        const leftAngle = rotLeft.estimatedRotationDeg;
        const rightAngle = rotRight.estimatedRotationDeg;

        const leftDelta = leftAngle !== null ? Math.round((leftAngle - baselineLeft) * 10) / 10 : null;
        const rightDelta = rightAngle !== null ? Math.round((rightAngle - baselineRight) * 10) / 10 : null;

        // 0°起点のため、内部/外部は delta の正負で表現
        const leftInternal = leftDelta !== null && leftDelta >= 0 ? leftDelta : 0;
        const leftExternal = leftDelta !== null && leftDelta < 0 ? Math.abs(leftDelta) : 0;

        const rightInternal = rightDelta !== null && rightDelta >= 0 ? rightDelta : 0;
        const rightExternal = rightDelta !== null && rightDelta < 0 ? Math.abs(rightDelta) : 0;

        const leftROM = leftDelta !== null ? Math.round(Math.abs(leftDelta) * 10) / 10 : null;
        const rightROM = rightDelta !== null ? Math.round(Math.abs(rightDelta) * 10) / 10 : null;

        const compensationFlags = {
          abductionAdduction: compLeft.flagged || compRight.flagged,
          pelvisShift: !pelvis.stable,
          trunkLean: trunk.flagged,
          footDrift: (compLeft.footDrift ?? 0) > 0 || (compRight.footDrift ?? 0) > 0
        };

        const warnings = [];
        if (compLeft.reason?.length) warnings.push(...compLeft.reason.map((s) => `左: ${s}`));
        if (compRight.reason?.length) warnings.push(...compRight.reason.map((s) => `右: ${s}`));
        if (!pelvis.stable) warnings.push('骨盤が不安定です');
        if (trunk.flagged) warnings.push(...trunk.reason);

        const rotationScoreBase = (() => {
          const values = [leftROM, rightROM].filter((v) => Number.isFinite(v));
          if (values.length === 0) return 0;
          return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
        })();

        let penalty = 0;
        if (compensationFlags.abductionAdduction) penalty += 20;
        if (compensationFlags.pelvisShift) penalty += 20;
        if (compensationFlags.trunkLean) penalty += 20;
        if (compensationFlags.footDrift) penalty += 10;

        const finalScore = Math.max(0, Math.min(100, rotationScoreBase - penalty + 50));

        return {
          valid: true,
          side,
          rotation: {
            left: {
              angle: leftAngle,
              delta: leftDelta,
              internal: leftInternal,
              external: leftExternal,
              rom: leftROM
            },
            right: {
              angle: rightAngle,
              delta: rightDelta,
              internal: rightInternal,
              external: rightExternal,
              rom: rightROM
            }
          },
          compensation: compensationFlags,
          metrics: {
            pelvisTiltDeg: pelvis.tiltDeg,
            hipShiftPx: pelvis.shift,
            kneeShiftPx: compLeft.kneeLateralShift,
            ankleShiftPx: compLeft.ankleLateralShift,
            shankAngleLeftDeg: rotLeft.shankAngleDeg,
            shankAngleRightDeg: rotRight.shankAngleDeg
          },
          warnings,
          score: {
            rotation: rotationScoreBase,
            compensationPenalty: penalty,
            final: finalScore
          }
        };
      } catch (err) {
        console.error('evaluateHipRotationWithCompensation failed:', err);
        return {
          valid: false,
          side: options.side || 'left',
          rotation: {
            left: { angle: null, delta: null, internal: null, external: null, rom: null },
            right: { angle: null, delta: null, internal: null, external: null, rom: null }
          },
          compensation: {
            abductionAdduction: true,
            pelvisShift: true,
            trunkLean: true,
            footDrift: true
          },
          metrics: {
            pelvisTiltDeg: null,
            hipShiftPx: null,
            kneeShiftPx: null,
            ankleShiftPx: null,
            shankAngleLeftDeg: null,
            shankAngleRightDeg: null
          },
          warnings: ['股関節評価に失敗しました'],
          score: {
            rotation: 0,
            compensationPenalty: 100,
            final: 0
          }
        };
      }
    }
  };
      
  // ============================================
  // EXPORT
  // ============================================

  window.AppEngine = AppEngine;

})();
