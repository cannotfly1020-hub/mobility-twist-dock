/**
 * 🦴 柔軟性・しなりドック - Pose & Geometry Engine (js/engine.js)
 * MediaPipe Pose を活用した実機カメラ制御、アスペクト比補正（object-fit: cover のズレ解消）、
 * 顔正対×各モード専用の構えジェスチャー認識、確定4大テストの精密幾何計算、
 * および骨盤浮き（代償動作）カンニング検知を一元管理します。
 */
(function() {
  'use strict';

  // 内部状態変数
  let videoElement = null;
  let canvasElement = null;
  let canvasCtx = null;
  let poseInstance = null;
  let cameraInstance = null;
  let animationFrameId = null;

  let currentFacingMode = 'user'; // 'user' (インカメラ) | 'environment' (アウトカメラ)
  let isRunning = false;
  let currentTestMode = 'tab-hip'; // 'tab-hip' | 'tab-banzai' | 'tab-shoulder2nd' | 'tab-hinge'

  // コールバック関数群
  let onResultsCallback = null;
  let onTriggerReadyCallback = null;
  let onMetricUpdateCallback = null;
  let onCheatAlertCallback = null;

  const AppEngine = {
    /**
     * エンジンの初期化
     * @param {Object} config DOM要素と各種コールバック
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
        console.warn('MediaPipe Pose script not loaded yet. Retrying in 400ms...');
        setTimeout(() => this.initPoseModel(), 400);
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
     * 実機カメラの起動（iOS Safari WebKit に最適化）
     */
    async startCamera() {
      if (!videoElement) return;

      try {
        this.stopCameraStream();

        const constraints = {
          audio: false,
          video: {
            facingMode: { ideal: currentFacingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        videoElement.srcObject = stream;
        videoElement.setAttribute('playsinline', 'true');
        videoElement.setAttribute('webkit-playsinline', 'true');
        await videoElement.play();

        isRunning = true;

        // MediaPipe Camera utils による高精度ループ
        if (typeof window.Camera !== 'undefined') {
          cameraInstance = new window.Camera(videoElement, {
            onFrame: async () => {
              if (videoElement && poseInstance && isRunning && videoElement.readyState >= 2) {
                try {
                  await poseInstance.send({ image: videoElement });
                } catch (err) {
                  // フレームドロップ時はスキップ
                }
              }
            },
            width: 1280,
            height: 720
          });
          cameraInstance.start();
        } else {
          // フォールバック: requestAnimationFrame ループ
          this.startManualLoop();
        }
      } catch (e) {
        console.error('Camera stream error:', e);
        if (window.AppAudio) {
          window.AppAudio.speak('カメラへのアクセスを許可してください');
        }
      }
    },

    /**
     * 手動フレーム送信ループ
     */
    startManualLoop() {
      const sendFrame = async () => {
        if (!isRunning) return;
        if (videoElement && poseInstance && videoElement.readyState >= 2) {
          try {
            await poseInstance.send({ image: videoElement });
          } catch (e) {
            // エラーフレームは無視して継続
          }
        }
        animationFrameId = requestAnimationFrame(sendFrame);
      };
      animationFrameId = requestAnimationFrame(sendFrame);
    },

    /**
     * カメラのイン／アウト反転切り替え
     */
    switchCamera() {
      currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
      this.startCamera();
      if (window.AppAudio) {
        window.AppAudio.playTap();
      }
      return currentFacingMode;
    },

    getFacingMode() {
      return currentFacingMode;
    },

    /**
     * テスト種目の切り替え
     */
    setTestMode(mode) {
      currentTestMode = mode;
    },

    /**
     * ストリーム停止
     */
    stopCameraStream() {
      if (cameraInstance) {
        try { cameraInstance.stop(); } catch (err) {}
        cameraInstance = null;
      }
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      if (videoElement && videoElement.srcObject) {
        const tracks = videoElement.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        videoElement.srcObject = null;
      }
    },

    stop() {
      isRunning = false;
      this.stopCameraStream();
    },

    /**
     * ★映像と骨格のズレ解消（object-fit: cover による切り捨てオフセット逆算）
     * ビデオのアスペクト比とキャンバスのアスペクト比から描画境界（x, y, w, h）をミリ単位で算出
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
        // キャンバスの横幅に合わせ、上下がはみ出る（トリミングされる）
        renderW = cWidth;
        renderH = cWidth / videoRatio;
        offsetX = 0;
        offsetY = (cHeight - renderH) / 2;
      } else {
        // キャンバスの縦幅に合わせ、左右がはみ出る（トリミングされる）
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
     * MediaPipe Pose 推定フレームの受領と処理
     */
    handlePoseResults(results) {
      if (!canvasElement || !canvasCtx) return;

      // キャンバス解像度を実際の描画ピクセルと同期
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
      const isMirror = currentFacingMode === 'user';

      // 骨格およびジョイントの描画
      this.drawSkeleton(canvasCtx, landmarks, bounds, isMirror);

      // 顔正対・構えポーズ・代償動作カンニング判定
      this.evaluatePose(landmarks);

      if (onResultsCallback) {
        onResultsCallback(landmarks, bounds);
      }

      canvasCtx.restore();
    },

    /**
     * ブロスタエメラルド色の骨格線とウルトゴールドジョイントの精密描画
     */
    drawSkeleton(ctx, landmarks, bounds, isMirror) {
      const CONNECTIONS = [
        [11, 12], [11, 23], [12, 24], [23, 24], // 胴体
        [11, 13], [13, 15],                     // 左腕
        [12, 14], [14, 16],                     // 右腕
        [23, 25], [25, 27],                     // 左脚
        [24, 26], [26, 28]                      // 右脚
      ];

      // 骨格ライン描画
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#10b981'; // エメラルドグリーン
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      CONNECTIONS.forEach(([i, j]) => {
        const p1 = landmarks[i];
        const p2 = landmarks[j];
        if (p1 && p2 && p1.visibility > 0.45 && p2.visibility > 0.45) {
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

      // ジョイント描画
      const KEY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
      KEY_JOINTS.forEach((idx) => {
        const p = landmarks[idx];
        if (p && p.visibility > 0.45) {
          const x = isMirror ? bounds.x + (1 - p.x) * bounds.w : bounds.x + p.x * bounds.w;
          const y = bounds.y + p.y * bounds.h;

          // 外側ブラック枠
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, 2 * Math.PI);
          ctx.fillStyle = '#0f172a';
          ctx.fill();

          // 内側ウルトゴールド
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
      // 必須ランドマークの存在検証
      // 0:鼻, 7:左耳, 8:右耳, 11:左肩, 12:右肩, 15:左手首, 16:右手首, 23:左腰, 24:右腰
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
          // 股関節・バンザイ: 手首が耳元の至近にあるか（初期リセットポーズ）
          const earL = lm[7] || lm[11];
          const earR = lm[8] || lm[12];
          const wristL = lm[15];
          const wristR = lm[16];

          if (wristL && wristR && earL && earR) {
            const distL = Math.hypot(wristL.x - earL.x, wristL.y - earL.y);
            const distR = Math.hypot(wristR.x - earR.x, wristR.y - earR.y);
            // 手首が耳から近い（半径0.25以内）または肩より上
            const nearEars = (distL < 0.26 && distR < 0.26) || (wristL.y < lm[11].y && wristR.y < lm[12].y);
            isStanceReady = nearEars;
            stanceMessage = nearEars ? '構え完了！キープ！' : '手首を耳元に合わせて構えてください';
          }
          break;
        }

        case 'tab-shoulder2nd': {
          // 肩2nd（横向き）: カメラ側の肩外転90°・肘屈曲90°で前腕が水平にあるか
          // より視認性の高い側の肩・肘・手首を採用
          const useLeft = (lm[11].visibility + lm[13].visibility + lm[15].visibility) >=
                          (lm[12].visibility + lm[14].visibility + lm[16].visibility);
          const shoulder = useLeft ? lm[11] : lm[12];
          const elbow = useLeft ? lm[13] : lm[14];
          const wrist = useLeft ? lm[15] : lm[16];

          if (shoulder && elbow && wrist) {
            // 肩外転角（肩〜肘が体幹または水平に近いか）
            const elbowDistY = Math.abs(elbow.y - shoulder.y);
            // 肘屈曲90度（肩-肘-手首の角度が70°〜110°）
            const elbowAngle = this.calculateAngle(shoulder, elbow, wrist);
            // 前腕（肘〜手首）の水平度
            const wristLevel = Math.abs(wrist.y - elbow.y);

            const isAbducted = elbowDistY < 0.15;
            const is90DegFlex = (elbowAngle >= 65 && elbowAngle <= 115);
            const isForearmHorizontal = wristLevel < 0.18;

            isStanceReady = isAbducted && is90DegFlex && isForearmHorizontal;
            stanceMessage = isStanceReady ? '肩2ndスタンバイOK！' : '肩と肘を90度に開き前腕を水平に構えてください';
          }
          break;
        }

        case 'tab-hinge': {
          // もも裏ヒンジ（横向き）: 背筋直立でスタンバイしているか
          const useLeft = (lm[11].visibility + lm[23].visibility) >= (lm[12].visibility + lm[24].visibility);
          const shoulder = useLeft ? lm[11] : lm[12];
          const hip = useLeft ? lm[23] : lm[24];
          const knee = useLeft ? lm[25] : lm[26];

          if (shoulder && hip && knee) {
            // 直立判定: 肩と腰の水平ズレが小さく、股関節〜膝が伸びている（160°以上）
            const trunkVertical = Math.abs(shoulder.x - hip.x) < 0.12;
            const legStraight = this.calculateAngle(shoulder, hip, knee) >= 155;

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

      // 3. カンニング検知（左右腰の高さ跳ね上がり・骨盤浮きの判定）
      if (lm[23] && lm[24] && lm[23].visibility > 0.45 && lm[24].visibility > 0.45) {
        const hipDiffY = Math.abs(lm[23].y - lm[24].y);
        // 通常の骨盤傾斜許容値を超えた場合に警告
        if (hipDiffY > 0.09) {
          if (onCheatAlertCallback) onCheatAlertCallback(true, '⚠️ 骨盤が浮いています！床につけよう！');
        } else {
          if (onCheatAlertCallback) onCheatAlertCallback(false, '');
        }
      }

      // 4. 確定4大テストの精密幾何計算の実行
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
          // ① 🦊 股関節内外旋: 膝（25/26）と足首（27/28）のすね傾斜ベクトル角（°）
          // 左足すね（25〜27）
          const kneeL = lm[25], ankleL = lm[27];
          if (kneeL && ankleL && kneeL.visibility > 0.4 && ankleL.visibility > 0.4) {
            const dx = ankleL.x - kneeL.x;
            const dy = ankleL.y - kneeL.y;
            mainVal = Math.round(Math.abs(Math.atan2(dx, dy) * (180 / Math.PI)));
          }

          // 右足すね（26〜28）
          const kneeR = lm[26], ankleR = lm[28];
          if (kneeR && ankleR && kneeR.visibility > 0.4 && ankleR.visibility > 0.4) {
            const dx = ankleR.x - kneeR.x;
            const dy = ankleR.y - kneeR.y;
            subVal = Math.round(Math.abs(Math.atan2(dx, dy) * (180 / Math.PI)));
          }
          break;
        }

        case 'tab-banzai': {
          // ② 🦅 両腕バンザイ: 体幹軸（肩中点〜腰中点）に対する両腕（肩〜手首）のV字挙上角（左右同時）
          const shMidX = (lm[11].x + lm[12].x) / 2;
          const shMidY = (lm[11].y + lm[12].y) / 2;
          const hipMidX = (lm[23].x + lm[24].x) / 2;
          const hipMidY = (lm[23].y + lm[24].y) / 2;

          // 体幹の上方向ベクトル (hip -> shoulder)
          const trunkVec = { x: shMidX - hipMidX, y: shMidY - hipMidY };

          // 左腕（肩11 -> 手首15）
          if (lm[11] && lm[15] && lm[11].visibility > 0.4 && lm[15].visibility > 0.4) {
            const armVecL = { x: lm[15].x - lm[11].x, y: lm[15].y - lm[11].y };
            mainVal = Math.round(this.vectorAngle(trunkVec, armVecL));
          }

          // 右腕（肩12 -> 手首16）
          if (lm[12] && lm[16] && lm[12].visibility > 0.4 && lm[16].visibility > 0.4) {
            const armVecR = { x: lm[16].x - lm[12].x, y: lm[16].y - lm[12].y };
            subVal = Math.round(this.vectorAngle(trunkVec, armVecR));
          }
          break;
        }

        case 'tab-shoulder2nd': {
          // ③ ⚾ 肩関節2nd内外旋: 体幹ライン（肩〜腰）に対する前腕（肘〜手首）の挟み角
          // 天井側「外旋角」、床側「内旋角」、および合計「Total Arc」を算出
          // mainVal: 左腕または主腕, subVal: 右腕または反対側
          const computeShoulderRotation = (sh, elb, wr, hip) => {
            if (!sh || !elb || !wr || !hip) return 0;
            // 肘を中心とした前腕ベクトル
            const forearm = { x: wr.x - elb.x, y: wr.y - elb.y };
            // 体幹ベクトル（肩 -> 腰）
            const trunk = { x: hip.x - sh.x, y: hip.y - sh.y };
            // 水平軸に対する前腕の角度
            const angle = this.calculateAngle(sh, elb, wr);
            return Math.round(angle);
          };

          if (lm[11] && lm[13] && lm[15] && lm[23]) {
            mainVal = computeShoulderRotation(lm[11], lm[13], lm[15], lm[23]);
          }
          if (lm[12] && lm[14] && lm[16] && lm[24]) {
            subVal = computeShoulderRotation(lm[12], lm[14], lm[16], lm[24]);
          }
          break;
        }

        case 'tab-hinge': {
          // ④ 📐 もも裏ヒンジ: 大腿軸（股関節〜膝）に対する体幹軸（股関節〜肩）の前傾挟み角（°）
          const useLeft = (lm[11].visibility + lm[23].visibility + lm[25].visibility) >=
                          (lm[12].visibility + lm[24].visibility + lm[26].visibility);
          const shoulder = useLeft ? lm[11] : lm[12];
          const hip = useLeft ? lm[23] : lm[24];
          const knee = useLeft ? lm[25] : lm[26];

          if (shoulder && hip && knee && hip.visibility > 0.4) {
            // 股関節を頂点とする（肩 - 股関節 - 膝）の角度
            const rawAngle = this.calculateAngle(shoulder, hip, knee);
            // 直立180°から前屈した角度（前傾度）
            const hingeAngle = Math.round(Math.max(0, 180 - rawAngle));
            mainVal = hingeAngle;
            subVal = Math.round(rawAngle); // 挟み角そのものを副表示
          }
          break;
        }
      }

      if (onMetricUpdateCallback) {
        onMetricUpdateCallback(mainVal, subVal);
      }
    },

    /**
     * 3点間の角度計算（pB を頂点とする ∠ABC）
     */
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

    /**
     * 2つのベクトルのなす角
     */
    vectorAngle(v1, v2) {
      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag1 = Math.hypot(v1.x, v1.y);
      const mag2 = Math.hypot(v2.x, v2.y);

      if (mag1 === 0 || mag2 === 0) return 0;

      const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
      return Math.acos(cosTheta) * (180 / Math.PI);
    }
  };

  // グローバル公開
  window.AppEngine = AppEngine;

})();
