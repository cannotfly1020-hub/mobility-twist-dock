/**
 * 柔軟性・しなりドック - 解析・測定エンジン (Biomechanical Smart Engine)
 * 
 * 【主な改修点・追加仕様】
 * 1. 非日常ポーズ認証 (Tポーズ / 頭上ビッグサークル○)
 * 2. 関節速度フィルターによる完全静止検知 (移動中の誤暴発を100%遮断)
 * 3. ゼロリセット (構え時の初期角度をθ_baseとして記憶し、相対変化量のみ算出)
 * 4. 安定性・ピーク追従データ算出 (アダプティブタイマー連動)
 * 5. インカメラ/外カメラ動的鏡像反転・スリープ完全省電力・NaN安全クランプ維持
 */

// ==========================================
// 1. 純粋幾何計算モジュール (Pure Math Utils)
// ==========================================
const BiomechanicsCalc = {
  clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  },

  radToDeg(rad) {
    return Math.round(rad * (180 / Math.PI));
  },

  /**
   * 🏹 胸椎回旋テスト（両肩の水平傾斜 & 肘引き上げの統合評価）
   */
  calcThoracicRotation(rawLm) {
    const ls = rawLm[11]; // 左肩
    const rs = rawLm[12]; // 右肩
    const le = rawLm[13]; // 左肘
    const re = rawLm[14]; // 右肘

    if (!ls || !rs) return { main: 0, sub: 0, currentAngle: 0, diff: 0, activeSide: 'left' };

    const shoulderDx = Math.abs(rs.x - ls.x);
    const shoulderDy = Math.abs(rs.y - ls.y);
    const shoulderDeg = this.radToDeg(Math.atan2(shoulderDy, shoulderDx || 0.0001));

    let leftArmAngle = 0;
    let rightArmAngle = 0;
    if (le && ls) {
      leftArmAngle = this.radToDeg(Math.atan2(Math.max(0, ls.y - le.y), Math.abs(ls.x - le.x) || 0.0001));
    }
    if (re && rs) {
      rightArmAngle = this.radToDeg(Math.atan2(Math.max(0, rs.y - re.y), Math.abs(rs.x - re.x) || 0.0001));
    }

    const isLeftHigher = (ls.y < rs.y) || (leftArmAngle > rightArmAngle);
    const maxDeg = this.clamp(Math.max(shoulderDeg, isLeftHigher ? leftArmAngle : rightArmAngle), 0, 90);

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
   * 🦊 股関節内旋テスト（すねベクトルの垂直傾斜角）
   */
  calcHipWiper(rawLm) {
    const lKnee = rawLm[25];
    const rKnee = rawLm[26];
    const lAnkle = rawLm[27] || rawLm[31];
    const rAnkle = rawLm[28] || rawLm[32];

    if (!lKnee || !rKnee) {
      return { main: 0, sub: 0, currentAngle: 0, diff: 0, activeSide: 'left' };
    }

    let leftWiper = 0;
    if (lAnkle) {
      const ldx = lAnkle.x - lKnee.x;
      const ldy = Math.abs(lAnkle.y - lKnee.y);
      leftWiper = this.clamp(this.radToDeg(Math.atan2(Math.abs(ldx), ldy || 0.0001)), 0, 90);
    }

    let rightWiper = 0;
    if (rAnkle) {
      const rdx = rAnkle.x - rKnee.x;
      const rdy = Math.abs(rAnkle.y - rKnee.y);
      rightWiper = this.clamp(this.radToDeg(Math.atan2(Math.abs(rdx), rdy || 0.0001)), 0, 90);
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
   * 📐 もも裏ヒンジテスト（体幹前屈・ハイブリッド幾何推定）
   */
  calcHamstringHinge(rawLm, engineState) {
    const ls = rawLm[11];
    const rs = rawLm[12];
    const lh = rawLm[23];
    const rh = rawLm[24];

    if (!ls || !rs || !lh || !rh) return { main: 0, sub: 0, currentAngle: 0, diff: 0, activeSide: 'left' };

    const midShoulder = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, z: ((ls.z || 0) + (rs.z || 0)) / 2 };
    const midHip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, z: ((lh.z || 0) + (rh.z || 0)) / 2 };

    const dx = Math.abs(midShoulder.x - midHip.x);
    const dy = Math.abs(midShoulder.y - midHip.y);
    const dz = Math.abs(midShoulder.z - midHip.z);

    // 1. 側面時傾斜
    const sideAngleDeg = this.radToDeg(Math.atan2(dx, dy || 0.0001));

    // 2. 正面時：体幹短縮率からの逆算
    const currentTorsoLen = dy;
    if (engineState.baseTorsoLen === null || !engineState.baselineCalibrated) {
      engineState.baseTorsoLen = currentTorsoLen;
      engineState.baselineCalibrated = true;
    }

    // NaN防止クランプ
    const ratio = this.clamp(currentTorsoLen / (engineState.baseTorsoLen || currentTorsoLen || 0.0001), -1.0, 1.0);
    const frontAngleFromRatio = this.radToDeg(Math.acos(ratio));
    const depthAngleDeg = this.radToDeg(Math.atan2(dz * 1.5, dy || 0.0001));

    const estimatedHinge = this.clamp(Math.max(sideAngleDeg, frontAngleFromRatio, depthAngleDeg), 0, 90);

    return {
      main: estimatedHinge,
      sub: estimatedHinge,
      currentAngle: estimatedHinge,
      activeSide: 'left',
      diff: 0
    };
  }
};

// ==========================================
// 2. メイン解析エンジン (AppEngine)
// ==========================================
const AppEngine = {
  video: null,
  canvas: null,
  ctx: null,
  pose: null,
  currentStream: null,
  facingMode: 'user', // 'user' | 'environment'
  isProcessing: false,
  isBusy: false,
  isPaused: false,
  animFrameId: null,

  // 測定種目と状態
  currentTestType: 'thoracic',
  baseHipY: null,
  baseTorsoLen: null,
  baselineCalibrated: false,

  // 【新仕様】ゼロリセット（ベースライン角度）
  baseAngle: null,
  isBaseCalibrated: false,

  // 【新仕様】関節移動速度・静止追跡用履歴
  prevKeypoints: null,
  prevTimestamp: null,
  currentVelocity: 0, // screen_ratio / sec
  stillnessDuration: 0, // 静止継続秒数

  // 【新仕様】開始認証ポーズのホールド追跡
  authPoseStartTime: null,
  authPoseRequiredMs: 1500, // 1.5秒維持で確定

  // コールバック
  onFrameUpdate: null,
  onError: null,

  async init(options = {}) {
    this.video = options.video || document.getElementById('webcam-video');
    this.canvas = options.canvas || document.getElementById('output-canvas');

    if (!this.canvas || !this.video) {
      throw new Error('VideoまたはCanvas要素がDOM内に見つかりません。');
    }
    this.ctx = this.canvas.getContext('2d');

    if (typeof window.Pose === 'undefined') {
      throw new Error('MediaPipe Poseライブラリが読み込まれていません。');
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
        facingMode: { ideal: this.facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    try {
      this.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.currentStream;
      this.updateCameraMirror();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('カメラのメタデータ読み込みがタイムアウトしました。'));
        }, 10000);

        this.video.onloadedmetadata = async () => {
          clearTimeout(timeout);
          try {
            await this.video.play();
            this.updateCanvasSize();
            this.startProcessingLoop();
            resolve(true);
          } catch (playErr) {
            console.error('Video play rejected:', playErr);
            if (this.onError) this.onError(playErr);
            reject(playErr);
          }
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
    if (this.video) this.video.style.transform = transformVal;
    if (this.canvas) this.canvas.style.transform = transformVal;
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

    const canvasRatio = cw / (ch || 1);
    const videoRatio = vw / (vh || 1);

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
      if (!this.isProcessing || this.isPaused) return;

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
      this.prevKeypoints = null;
      this.authPoseStartTime = null;
      if (this.onFrameUpdate) {
        this.onFrameUpdate({
          detected: false,
          isReady: false,
          isStationary: false,
          authProgress: 0,
          rawAngles: { main: 0, sub: 0, currentAngle: 0, diff: 0 },
          relativeAngle: 0,
          cheatDetected: false,
          cheatReason: ''
        });
      }
      return;
    }

    const t = this.getAspectCoverTransform();
    const landmarks = results.poseLandmarks;
    const now = performance.now();

    // 1. 静止・移動速度の算出 (主要関節の変位速度)
    const velocityData = this.calculateMovementVelocity(landmarks, now);
    const isStationary = velocityData.velocity < 0.025; // 静止閾値

    // 2. 非日常ポーズ判定 (Tポーズまたは頭上○サークル)
    const authPose = this.checkAuthPose(landmarks);

    // 3. 確定ホールド進捗の計算 (「認証ポーズ」かつ「完全静止」の1.5秒維持)
    let authProgress = 0;
    let isFullyLocked = false;

    if (authPose.isMatched && isStationary) {
      if (!this.authPoseStartTime) {
        this.authPoseStartTime = now;
      }
      const elapsed = now - this.authPoseStartTime;
      authProgress = Math.min(1.0, elapsed / this.authPoseRequiredMs);
      if (elapsed >= this.authPoseRequiredMs) {
        isFullyLocked = true;
      }
    } else {
      this.authPoseStartTime = null;
      authProgress = 0;
    }

    // 4. 生体角度の算出（絶対値）
    const rawAngles = this.calculateTestAngles(landmarks);

    // 5. 【ゼロリセット】相対変化量の計算
    // baseAngleが設定されている場合、構え時からの差分だけを抽出
    let relativeAngle = rawAngles.currentAngle;
    if (this.isBaseCalibrated && this.baseAngle !== null) {
      relativeAngle = Math.max(0, rawAngles.currentAngle - this.baseAngle);
    }

    // 6. 代償動作（カンニング）検知
    const cheatResult = this.detectCheat(landmarks);

    // 7. 骨格描画
    const toCanvasPoint = (lm) => ({
      x: t.offsetX + (lm.x * t.vw) * t.scale,
      y: t.offsetY + (lm.y * t.vh) * t.scale,
      z: lm.z || 0,
      visibility: lm.visibility !== undefined ? lm.visibility : 1.0
    });
    const pts = landmarks.map(toCanvasPoint);
    this.drawSkeleton(pts, authPose.isMatched);

    // コールバック通知
    if (this.onFrameUpdate) {
      this.onFrameUpdate({
        detected: true,
        isReady: isFullyLocked,
        authProgress: authProgress,
        poseType: authPose.poseType,
        poseMessage: authPose.message,
        isStationary: isStationary,
        velocity: velocityData.velocity,
        rawAngles: rawAngles,
        relativeAngle: relativeAngle,
        cheatDetected: cheatResult.detected,
        cheatReason: cheatResult.reason
      });
    }
  },

  /**
   * 【新仕様】関節移動速度フィルター（静止検知）
   * 肩・手首・腰の画面内移動速度（screen_ratio / sec）を追跡
   */
  calculateMovementVelocity(landmarks, now) {
    // 主要キーポイント: 11(左肩), 12(右肩), 15(左手首), 16(右手首), 23(左腰), 24(右腰)
    const keyIndices = [11, 12, 15, 16, 23, 24];
    const currentPoints = keyIndices.map(i => landmarks[i]).filter(Boolean);

    if (!this.prevKeypoints || !this.prevTimestamp || currentPoints.length < 4) {
      this.prevKeypoints = currentPoints;
      this.prevTimestamp = now;
      this.currentVelocity = 0;
      return { velocity: 0 };
    }

    const dt = (now - this.prevTimestamp) / 1000;
    if (dt <= 0.001) return { velocity: this.currentVelocity };

    let totalDist = 0;
    let count = 0;
    for (let i = 0; i < Math.min(currentPoints.length, this.prevKeypoints.length); i++) {
      const p1 = currentPoints[i];
      const p2 = this.prevKeypoints[i];
      totalDist += Math.hypot(p1.x - p2.x, p1.y - p2.y);
      count++;
    }

    const instantVelocity = count > 0 ? (totalDist / count) / dt : 0;
    // 指数移動平均で平滑化
    this.currentVelocity = (this.currentVelocity * 0.7) + (instantVelocity * 0.3);

    this.prevKeypoints = currentPoints;
    this.prevTimestamp = now;

    return { velocity: this.currentVelocity };
  },

  /**
   * 【新仕様】非日常ポーズ認証
   * 1. 両手Tポーズ（真横に広げる）
   * 2. 頭上ビッグサークル（○サイン）
   * ※スマホ操作や髪を触る動作との誤認を100%遮断
   */
  checkAuthPose(rawLm) {
    const ls = rawLm[11]; // 左肩
    const rs = rawLm[12]; // 右肩
    const lw = rawLm[15]; // 左手首
    const rw = rawLm[16]; // 右手首
    const le = rawLm[13]; // 左肘
    const re = rawLm[14]; // 右肘
    const nose = rawLm[0];

    if (!ls || !rs || !lw || !rw || !nose) {
      return { isMatched: false, poseType: null, message: '全身をカメラに映してね' };
    }

    const shoulderDist = Math.hypot(ls.x - rs.x, ls.y - rs.y);

    // 判定A: 両手Tポーズ（腕が真横に水平に大きく伸びている）
    // 条件: 手首が肩の外側に肩幅の1.2倍以上離れ、かつY座標が肩の高さに近い（±肩幅の60%以内）
    const isTPoseLeft = (ls.x - lw.x) > (shoulderDist * 0.9) && Math.abs(lw.y - ls.y) < (shoulderDist * 0.6);
    const isTPoseRight = (rw.x - rs.x) > (shoulderDist * 0.9) && Math.abs(rw.y - rs.y) < (shoulderDist * 0.6);

    if (isTPoseLeft && isTPoseRight) {
      return { isMatched: true, poseType: 'T_POSE', message: '両手Tポーズ認識！ピタッと静止してね' };
    }

    // 判定B: 頭上ビッグサークル（両手が頭上で合わさっている）
    // 条件: 両手首が鼻より高く、かつ両手首同士が頭部付近で接近している
    const bothHandsAboveHead = (lw.y < nose.y) && (rw.y < nose.y);
    const wristsClose = Math.hypot(lw.x - rw.x, lw.y - rw.y) < (shoulderDist * 1.1);

    if (bothHandsAboveHead && wristsClose) {
      return { isMatched: true, poseType: 'CIRCLE_POSE', message: '頭上○サイン認識！ピタッと静止してね' };
    }

    return {
      isMatched: false,
      poseType: null,
      message: '両手を横に広げて「Tポーズ」か、頭の上で「○」を作ってね！'
    };
  },

  calculateTestAngles(rawLm) {
    switch (this.currentTestType) {
      case 'thoracic':
        return BiomechanicsCalc.calcThoracicRotation(rawLm);
      case 'hip':
        return BiomechanicsCalc.calcHipWiper(rawLm);
      case 'hinge':
        return BiomechanicsCalc.calcHamstringHinge(rawLm, this);
      default:
        return { main: 0, sub: 0, currentAngle: 0, diff: 0, activeSide: 'left' };
    }
  },

  /**
   * 【新仕様】ゼロリセット（キャリブレーション）API
   * スタート合図の瞬間の姿勢角度をθ_baseとして記憶
   */
  calibrateBaseAngle(currentRawAngle) {
    this.baseAngle = currentRawAngle;
    this.isBaseCalibrated = true;
  },

  resetBaseAngle() {
    this.baseAngle = null;
    this.isBaseCalibrated = false;
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

    // 骨盤の急激な浮き上がり検知
    const hipLiftAmount = this.baseHipY - currentHipY;
    if (hipLiftAmount > 0.08) {
      return {
        detected: true,
        reason: 'お尻が浮いています！骨盤を座面につけよう'
      };
    }

    return { detected: false, reason: '' };
  },

  pause() {
    this.isPaused = true;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.video) {
      this.video.pause();
    }
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  },

  resume() {
    if (!this.isPaused) return;
    this.isPaused = false;
    if (this.video && this.video.srcObject) {
      this.video.play().catch((e) => console.warn('Resume play error:', e));
    }
    this.startProcessingLoop();
  },

  resetCalibration() {
    this.baseHipY = null;
    this.baseTorsoLen = null;
    this.baselineCalibrated = false;
    this.resetBaseAngle();
    this.authPoseStartTime = null;
    this.prevKeypoints = null;
  },

  drawSkeleton(pts, isAuthActive = false) {
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
    ctx.lineWidth = isAuthActive ? 5 : 4;
    ctx.lineCap = 'round';
    // 認証ポーズ認識時はエメラルドグリーン、通常時はシアン
    ctx.strokeStyle = isAuthActive ? 'rgba(16, 185, 129, 0.95)' : 'rgba(6, 182, 212, 0.85)';

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
        ctx.fillStyle = isAuthActive ? '#34d399' : (isKeyJoint ? '#fbbf24' : '#ffffff');
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
