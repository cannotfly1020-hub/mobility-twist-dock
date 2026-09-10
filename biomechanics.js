/**
 * 柔軟性・しなりドック - 解析・測定エンジン
 * MediaPipe Pose連携、高精度アスペクト比補正、外カメラ/インカメラ鏡像制御、3大テスト角度・代償検知
 */
const AppEngine = {
  video: null,
  canvas: null,
  ctx: null,
  pose: null,
  currentStream: null,
  facingMode: 'user', // 'user' (インカメラ) または 'environment' (外カメラ)
  isProcessing: false,
  isBusy: false, // 重複推論防止フラグ
  isPaused: false, // スリープ一時停止フラグ
  isPaused: false,
  animFrameId: null,

  // 測定中および初期キャリブレーションデータ
  currentTestType: 'thoracic', // 'thoracic' | 'hip' | 'hinge'
  baseHipY: null, // 代償動作（お尻浮き）検知用基準腰高
  baseTorsoLen: null, // 前屈短縮率計算用基準体幹長
  baselineCalibrated: false,
  
  // コールバック関数群
  onFrameUpdate: null,
  onError: null,

  async init(options = {}) {
    this.video = options.video || document.getElementById('webcam-video');
    this.canvas = options.canvas || document.getElementById('output-canvas');
    if (!this.canvas || !this.video) {
      throw new Error('VideoまたはCanvas要素が見つかりません');
    }
    this.ctx = this.canvas.getContext('2d');

    if (typeof window.Pose === 'undefined') {
      throw new Error('MediaPipe Poseライブラリが読み込まれていません');
    }

    this.pose = new window.Pose({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
    });

    this.pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      smoothSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    this.pose.onResults(this.handlePoseResults.bind(this));
  },

  async startCamera() {
    this.stopCamera();

    const constraints = {
      audio: false,
      video: {
        facingMode: this.facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    try {
      this.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.currentStream;

      // インカメラは鏡像反転 (scaleX(-1))、外カメラは正像 (scaleX(1)) に切り替え
      this.updateCameraMirror();

      return new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          this.video.play();
          this.updateCanvasSize();
          this.startProcessingLoop();
          resolve(true);
        };
      });
    } catch (err) {
      console.error('Camera access error:', err);
      if (this.onError) this.onError(err);
      throw err;
    }
  },

  updateCameraMirror() {
    const isUserFacing = this.facingMode === 'user';
    const transformVal = isUserFacing ? 'scaleX(-1)' : 'scaleX(1)';
    if (this.video) {
      this.video.style.transform = transformVal;
    }
    if (this.canvas) {
      this.canvas.style.transform = transformVal;
    }
  },

  stopCamera() {
    this.isProcessing = false;
    this.isBusy = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.currentStream) {
      this.currentStream.getTracks().forEach((track) => track.stop());
      this.currentStream = null;
    }
  },

  async switchCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    return await this.startCamera();
  },

  getAspectCoverTransform() {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;

    const canvasRatio = cw / ch;
    const videoRatio = vw / vh;

    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;

    if (canvasRatio > videoRatio) {
      scale = cw / vw;
      offsetY = (ch - vh * scale) / 2;
    } else {
      scale = ch / vh;
      offsetX = (cw - vw * scale) / 2;
    }

    return { scale, offsetX, offsetY, vw, vh, cw, ch };
  },

  updateCanvasSize() {
    if (!this.canvas || !this.canvas.parentElement) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
  },

  startProcessingLoop() {
    this.isProcessing = true;
    this.isBusy = false;

    const loop = async () => {
      if (!this.isProcessing) return;
      if (this.isPaused) { ... return; }
      
      // スリープ一時停止中は推論をスキップ
      if (this.isPaused) {
        this.animFrameId = requestAnimationFrame(loop);
        return;
      }

      // 前の推論処理が完了している時のみ新しいフレームを送信（スタック防止）
      if (!this.isBusy && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        this.isBusy = true;
        try {
          await this.pose.send({ image: this.video });
        } catch (e) {
          console.warn('Pose send error:', e);
        } finally {
          this.isBusy = false;
        }
      }
      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  },

  handlePoseResults(results) {
    if (!this.ctx || !this.canvas) return;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!results.poseLandmarks) {
      if (this.onFrameUpdate) {
        this.onFrameUpdate({
          detected: false,
          isReady: false,
          angles: { main: 0, sub: 0, currentAngle: 0 },
          cheatDetected: false,
          cheatReason: ''
        });
      }
      return;
    }

    const t = this.getAspectCoverTransform();
    const landmarks = results.poseLandmarks;

    const toCanvasPoint = (lm) => ({
      x: t.offsetX + (lm.x * t.vw) * t.scale,
      y: t.offsetY + (lm.y * t.vh) * t.scale,
      z: lm.z,
      visibility: lm.visibility !== undefined ? lm.visibility : 1.0
    });

    const pts = landmarks.map(toCanvasPoint);

    const readyState = this.checkReadyGesture(landmarks);
    const testMetrics = this.calculateTestAngles(landmarks);
    const cheatResult = this.detectCheat(landmarks);

    this.drawSkeleton(pts);

    if (this.onFrameUpdate) {
      this.onFrameUpdate({
        detected: true,
        isReady: readyState.isReady,
        readyScore: readyState.score,
        readyMessage: readyState.message,
        angles: testMetrics,
        cheatDetected: cheatResult.detected,
        cheatReason: cheatResult.reason
      });
    }
  },

  checkReadyGesture(rawLm) {
    const nose = rawLm[0];
    const leftEar = rawLm[7];
    const rightEar = rawLm[8];
    const leftWrist = rawLm[15];
    const rightWrist = rawLm[16];

    if (!nose || !leftEar || !rightEar) {
      return { isReady: false, score: 0, message: 'カメラに全身を映してください' };
    }

    // 正対判定（ジュニアが認識されやすいようマージンを調整）
    const distLeftEar = Math.abs(nose.x - leftEar.x);
    const distRightEar = Math.abs(nose.x - rightEar.x);
    const maxDist = Math.max(distLeftEar, distRightEar);
    const isFacingForward = maxDist > 0.01;

    // 手首が耳や頭部周辺にあるか
    const headWidth = Math.abs(leftEar.x - rightEar.x) + 0.08;
    const leftHandNearHead = leftWrist && Math.hypot(leftWrist.x - leftEar.x, leftWrist.y - leftEar.y) < headWidth * 2.2;
    const rightHandNearHead = rightWrist && Math.hypot(rightWrist.x - rightEar.x, rightWrist.y - rightEar.y) < headWidth * 2.2;

    const hasPoseReady = leftHandNearHead || rightHandNearHead;

    if (!isFacingForward) {
      return { isReady: false, score: 0.3, message: 'カメラの方を向いてね' };
    }
    if (!hasPoseReady) {
      return { isReady: false, score: 0.6, message: '耳の後ろに手を当てて構えよう！' };
    }

    return { isReady: true, score: 1.0, message: '構えOK！1秒キープ' };
  },

  calculateTestAngles(rawLm) {
    switch (this.currentTestType) {
      case 'thoracic':
        return this.calcThoracicRotation(rawLm);
      case 'hip':
        return this.calcHipWiper(rawLm);
      case 'hinge':
        return this.calcHamstringHinge(rawLm);
      default:
        return { main: 0, sub: 0, currentAngle: 0, diff: 0 };
    }
  },

  /**
   * 🏹 胸椎回旋テスト（正座お辞儀姿勢）
   * 両肩ラインの傾斜角および肘の引き上げ角を統合評価
   */
  calcThoracicRotation(rawLm) {
    const ls = rawLm[11]; // 左肩
    const rs = rawLm[12]; // 右肩
    const le = rawLm[13]; // 左肘
    const re = rawLm[14]; // 右肘

    if (!ls || !rs) return { main: 0, sub: 0, currentAngle: 0, diff: 0 };

    // 水平軸に対する両肩の高低差と幅から傾斜角（0〜90°）を算出
    const shoulderDx = Math.abs(rs.x - ls.x);
    const shoulderDy = Math.abs(rs.y - ls.y);
    const shoulderAngleRad = Math.atan2(shoulderDy, shoulderDx || 0.001);
    let shoulderDeg = Math.round(shoulderAngleRad * (180 / Math.PI));

    // 肘が上がっている側の回旋ブースト
    let leftArmAngle = 0;
    let rightArmAngle = 0;
    if (le && ls) {
      const armRad = Math.atan2(Math.max(0, ls.y - le.y), Math.abs(ls.x - le.x) || 0.001);
      leftArmAngle = Math.round(armRad * (180 / Math.PI));
    }
    if (re && rs) {
      const armRad = Math.atan2(Math.max(0, rs.y - re.y), Math.abs(rs.x - re.x) || 0.001);
      rightArmAngle = Math.round(armRad * (180 / Math.PI));
    }

    // 左肩・左肘が上がっている（Y座標が小さい）か判定
    const isLeftHigher = (ls.y < rs.y) || (leftArmAngle > rightArmAngle);
    const maxDeg = Math.min(90, Math.max(shoulderDeg, isLeftHigher ? leftArmAngle : rightArmAngle));

    const leftVal = isLeftHigher ? maxDeg : Math.max(0, shoulderDeg - 10);
    const rightVal = !isLeftHigher ? maxDeg : Math.max(0, shoulderDeg - 10);

    return {
      main: leftVal,
      sub: rightVal,
      currentAngle: maxDeg,
      activeSide: isLeftHigher ? 'left' : 'right',
      diff: Math.abs(leftVal - rightVal)
    };
  },

  /**
   * 🦊 股関節内旋テスト（椅子ワイパー）
   * 膝と足首の傾き（足首見切れ時はつま先をフォールバック）
   */
  calcHipWiper(rawLm) {
    const lKnee = rawLm[25];
    const rKnee = rawLm[26];
    const lAnkle = rawLm[27] || rawLm[31];
    const rAnkle = rawLm[28] || rawLm[32];

    if (!lKnee || !rKnee) {
      return { main: 0, sub: 0, currentAngle: 0, diff: 0 };
    }

    let leftWiper = 0;
    if (lAnkle) {
      const ldx = lAnkle.x - lKnee.x;
      const ldy = Math.abs(lAnkle.y - lKnee.y);
      const lAngleRad = Math.atan2(Math.abs(ldx), ldy || 0.001);
      leftWiper = Math.min(90, Math.round(lAngleRad * (180 / Math.PI)));
    }

    let rightWiper = 0;
    if (rAnkle) {
      const rdx = rAnkle.x - rKnee.x;
      const rdy = Math.abs(rAnkle.y - rKnee.y);
      const rAngleRad = Math.atan2(Math.abs(rdx), rdy || 0.001);
      rightWiper = Math.min(90, Math.round(rAngleRad * (180 / Math.PI)));
    }

    const currentMax = Math.max(leftWiper, rightWiper);
    const activeSide = leftWiper >= rightWiper ? 'left' : 'right';

    return {
      main: leftWiper,
      sub: rightWiper,
      currentAngle: currentMax,
      activeSide: activeSide,
      diff: Math.abs(leftWiper - rightWiper)
    };
  },

  /**
   * 📐 もも裏ヒンジテスト（体幹前屈）
   * 側面時のdx/dyと、正面時の体幹短縮率・Z深度変化をハイブリッド算出
   */
  calcHamstringHinge(rawLm) {
    const ls = rawLm[11];
    const rs = rawLm[12];
    const lh = rawLm[23];
    const rh = rawLm[24];

    if (!ls || !rs || !lh || !rh) return { main: 0, sub: 0, currentAngle: 0, diff: 0 };

    const midShoulder = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, z: ((ls.z || 0) + (rs.z || 0)) / 2 };
    const midHip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, z: ((lh.z || 0) + (rh.z || 0)) / 2 };

    const dx = Math.abs(midShoulder.x - midHip.x);
    const dy = Math.abs(midShoulder.y - midHip.y);
    const dz = Math.abs(midShoulder.z - midHip.z);

    // 1. 横向き（側面カメラ）時の傾斜
    const sideAngleRad = Math.atan2(dx, dy || 0.001);
    const sideAngleDeg = Math.round(sideAngleRad * (180 / Math.PI));

    // 2. 正面カメラ時：直立状態からの体幹縦長さの縮み率＆Z深度による前傾計算
    const currentTorsoLen = dy;
    if (this.baseTorsoLen === null || !this.baselineCalibrated) {
      this.baseTorsoLen = currentTorsoLen;
      this.baselineCalibrated = true;
    }

    // 直立長に対する比率から前傾角度を幾何学的に推定 (cos θ = current / base)
    const ratio = Math.min(1.0, currentTorsoLen / (this.baseTorsoLen || currentTorsoLen || 0.001));
    const frontAngleFromRatio = Math.round(Math.acos(ratio) * (180 / Math.PI));
    
    // Z深度との合成
    const depthAngleRad = Math.atan2(dz * 1.5, dy || 0.001);
    const depthAngleDeg = Math.round(depthAngleRad * (180 / Math.PI));

    // 側面と正面の最大値を採用
    const estimatedHinge = Math.min(90, Math.max(sideAngleDeg, frontAngleFromRatio, depthAngleDeg));

    return {
      main: estimatedHinge,
      sub: estimatedHinge,
      currentAngle: estimatedHinge,
      activeSide: 'left',
      diff: 0
    };
  },

  detectCheat(rawLm) {
    const lh = rawLm[23];
    const rh = rawLm[24];
    if (!lh || !rh) return { detected: false, reason: '' };

    const currentHipY = (lh.y + rh.y) / 2;

    if (this.baseHipY === null) {
      this.baseHipY = currentHipY;
      return { detected: false, reason: '' };
    }

    // 骨盤の急激な浮き上がり（画面の8%以上の急変）
    const hipLiftAmount = this.baseHipY - currentHipY;
    if (hipLiftAmount > 0.08) {
      return {
        detected: true,
        reason: 'お尻が浮いています！骨盤を床につけて回旋しよう'
      };
    }

    return { detected: false, reason: '' };
  },

  pause() {
    this.isPaused = true;
    if (this.video) this.video.pause();
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  },

  resume() {
    this.isPaused = false;
    if (this.video && this.video.srcObject) {
      this.video.play().catch(() => {});
    }
  },
 
  resetCalibration() {
    this.baseHipY = null;
    this.baseTorsoLen = null;
    this.baselineCalibrated = false;
  },

  drawSkeleton(pts) {
    const ctx = this.ctx;

    const connections = [
      [11, 12],
      [11, 13], [13, 15],
      [12, 14], [14, 16],
      [11, 23], [12, 24],
      [23, 24],
      [23, 25], [25, 27],
      [24, 26], [26, 28]
    ];

    ctx.save();
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.85)';

    connections.forEach(([i, j]) => {
      const p1 = pts[i];
      const p2 = pts[j];
      if (p1 && p2 && p1.visibility > 0.3 && p2.visibility > 0.3) {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    });

    pts.forEach((p, idx) => {
      if (p && p.visibility > 0.3) {
        const isKeyJoint = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28].includes(idx);
        ctx.beginPath();
        ctx.arc(p.x, p.y, isKeyJoint ? 6 : 3, 0, 2 * Math.PI);
        ctx.fillStyle = isKeyJoint ? '#fbbf24' : '#ffffff';
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      }
    });

    ctx.restore();
  }
};

window.AppEngine = AppEngine;
pause() { ... } 
resume() { ... }
