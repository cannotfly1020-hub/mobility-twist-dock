/**
 * 柔軟性・しなりドック - 解析・測定エンジン
 * MediaPipe Pose連携、高精度アスペクト比補正、3大テスト角度・代償検知
 */
const AppEngine = {
  video: null,
  canvas: null,
  ctx: null,
  pose: null,
  currentStream: null,
  facingMode: 'user', // 'user' (インカメ) or 'environment' (外カメ)
  isProcessing: false,
  animFrameId: null,

  // 測定中および初期キャリブレーションデータ
  currentTestType: 'thoracic', // 'thoracic' | 'hip' | 'hinge'
  baseHipY: null, // カンニング（浮き上がり）検知用基準腰高
  baselineCalibrated: false,
  
  // コールバック関数群
  onFrameUpdate: null, // フレーム毎の結果通知 (metrics, cheat, poseStatus)
  onError: null,

  /**
   * エンジンの初期化
   * @param {Object} options
   */
  async init(options = {}) {
    this.video = options.video || document.getElementById('webcam-video');
    this.canvas = options.canvas || document.getElementById('output-canvas');
    if (!this.canvas || !this.video) {
      throw new Error('VideoまたはCanvas要素が見つかりません');
    }
    this.ctx = this.canvas.getContext('2d');

    // MediaPipe Pose のセットアップ
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
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });

    this.pose.onResults(this.handlePoseResults.bind(this));
  },

  /**
   * カメラの起動（iOS Safari完全対応）
   */
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

  /**
   * カメラ停止
   */
  stopCamera() {
    this.isProcessing = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.currentStream) {
      this.currentStream.getTracks().forEach((track) => track.stop());
      this.currentStream = null;
    }
  },

  /**
   * インカメ / 外カメのトグル切り替え
   */
  async switchCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    return await this.startCamera();
  },

  /**
   * 【超重要】CSSの object-fit: cover に伴う映像切り抜き倍率とオフセットを計算
   * Canvasの論理解像度と描画サイズを同期し、1ミリのズレもなく重なる座標変換を算出
   */
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
      // 横幅に合わせて拡大、縦が上下に切り抜かれる
      scale = cw / vw;
      offsetY = (ch - vh * scale) / 2;
    } else {
      // 縦幅に合わせて拡大、横が左右に切り抜かれる
      scale = ch / vh;
      offsetX = (cw - vw * scale) / 2;
    }

    return { scale, offsetX, offsetY, vw, vh, cw, ch };
  },

  /**
   * Canvasの解像度をコンテナ要素のピクセル数にフィットさせる
   */
  updateCanvasSize() {
    if (!this.canvas || !this.canvas.parentElement) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // 描画品質とパフォーマンスのバランスを取るため幅は実寸ベース
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
  },

  /**
   * 推論ループの実行 (MediaPipeへのフレーム転送)
   */
  startProcessingLoop() {
    this.isProcessing = true;

    const loop = async () => {
      if (!this.isProcessing) return;
      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          await this.pose.send({ image: this.video });
        } catch (e) {
          console.warn('Pose send error:', e);
        }
      }
      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  },

  /**
   * MediaPipe Poseの結果ハンドラ
   */
  handlePoseResults(results) {
    if (!this.ctx || !this.canvas) return;

    // キャンバスリセット
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!results.poseLandmarks) {
      if (this.onFrameUpdate) {
        this.onFrameUpdate({
          detected: false,
          isReady: false,
          angles: { main: 0, sub: 0 },
          cheatDetected: false,
          cheatReason: ''
        });
      }
      return;
    }

    const t = this.getAspectCoverTransform();
    const landmarks = results.poseLandmarks;

    // 正規化座標(0.0 - 1.0)をCover表示座標へ変換するヘルパー
    const toCanvasPoint = (lm) => ({
      x: t.offsetX + (lm.x * t.vw) * t.scale,
      y: t.offsetY + (lm.y * t.vh) * t.scale,
      z: lm.z,
      visibility: lm.visibility !== undefined ? lm.visibility : 1.0
    });

    const pts = landmarks.map(toCanvasPoint);

    // 1. スタート認証（顔正対 × 構えジェスチャー）の判定
    const readyState = this.checkReadyGesture(landmarks);

    // 2. テスト別の精密角度計算
    const testMetrics = this.calculateTestAngles(landmarks);

    // 3. カンニング（代償動作・浮き上がり）検知
    const cheatResult = this.detectCheat(landmarks);

    // 4. スケルトン & ランドマークの描画
    this.drawSkeleton(pts);

    // 5. アプリケーション層への通知
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

  /**
   * 【顔認識 × 構えポーズ】スタート認証クロス検証
   * 鼻が両耳の中央にあるか（正面正対度）+ 指定の手首が耳・頭部付近にあるかを検知
   */
  checkReadyGesture(rawLm) {
    const nose = rawLm[0];
    const leftEar = rawLm[7];
    const rightEar = rawLm[8];
    const leftWrist = rawLm[15];
    const rightWrist = rawLm[16];

    // 顔主要点の可視度チェック
    if (!nose || !leftEar || !rightEar) {
      return { isReady: false, score: 0, message: '顔全体を映してください' };
    }

    // 1. 正対度チェック (鼻と左右耳の距離比率)
    const distLeftEar = Math.abs(nose.x - leftEar.x);
    const distRightEar = Math.abs(nose.x - rightEar.x);
    const earRatio = Math.min(distLeftEar, distRightEar) / (Math.max(distLeftEar, distRightEar) + 0.0001);
    const isFacingForward = earRatio > 0.45; // 0.45以上なら十分正対

    // 2. 構えジェスチャーチェック (左右どちらかの手首が同側の耳の近傍にあるか)
    // 距離閾値: 耳から頭部幅の約1.5倍以内
    const headWidth = Math.abs(leftEar.x - rightEar.x) + 0.05;
    const leftHandNearEar = Math.hypot(leftWrist.x - leftEar.x, leftWrist.y - leftEar.y) < headWidth * 1.6;
    const rightHandNearEar = Math.hypot(rightWrist.x - rightEar.x, rightWrist.y - rightEar.y) < headWidth * 1.6;

    const hasPoseReady = leftHandNearEar || rightHandNearEar;

    if (!isFacingForward) {
      return { isReady: false, score: earRatio, message: 'カメラの正面を向いてね' };
    }
    if (!hasPoseReady) {
      return { isReady: false, score: 0.5, message: '耳の後ろに手を当てて構えよう！' };
    }

    return { isReady: true, score: 1.0, message: '構えOK！キープしてね' };
  },

  /**
   * 3大テストの精密角度計算
   */
  calculateTestAngles(rawLm) {
    switch (this.currentTestType) {
      case 'thoracic':
        return this.calcThoracicRotation(rawLm);
      case 'hip':
        return this.calcHipWiper(rawLm);
      case 'hinge':
        return this.calcHamstringHinge(rawLm);
      default:
        return { main: 0, sub: 0, diff: 0 };
    }
  },

  /**
   * 🏹 胸椎回旋テスト（正座お辞儀姿勢）
   * 両肩（11, 12）ベクトルの水平に対する傾斜角
   */
  calcThoracicRotation(rawLm) {
    const ls = rawLm[11]; // 左肩
    const rs = rawLm[12]; // 右肩

    if (!ls || !rs) return { main: 0, sub: 0, diff: 0 };

    const dx = rs.x - ls.x;
    const dy = rs.y - ls.y;
    // 水平軸に対する両肩ラインの傾き角 (度数法)
    const angleRad = Math.atan2(dy, dx);
    let angleDeg = Math.round(Math.abs(angleRad * (180 / Math.PI)));

    // 水平(0度)からの開き度合いに整形 (最大90度想定)
    if (angleDeg > 90) angleDeg = 180 - angleDeg;

    // 回旋方向（左肩が上がっているか右肩が上がっているか）
    const isLeftOpen = ls.y < rs.y;

    return {
      main: isLeftOpen ? angleDeg : 0,
      sub: !isLeftOpen ? angleDeg : 0,
      currentAngle: angleDeg,
      activeSide: isLeftOpen ? 'left' : 'right'
    };
  },

  /**
   * 🦊 股関節内旋テスト（椅子ワイパー）
   * 誤差が出やすい大転子を除外し、膝(25, 26)と足首(27, 28)の「すねベクトル」の垂直傾斜角
   */
  calcHipWiper(rawLm) {
    const lKnee = rawLm[25];
    const rKnee = rawLm[26];
    const lAnkle = rawLm[27];
    const rAnkle = rawLm[28];

    if (!lKnee || !lAnkle || !rKnee || !rAnkle) {
      return { main: 0, sub: 0, diff: 0 };
    }

    // 左脚すねの垂直に対する傾斜角
    const ldx = lAnkle.x - lKnee.x;
    const ldy = lAnkle.y - lKnee.y;
    const lAngleRad = Math.atan2(Math.abs(ldx), Math.abs(ldy));
    const leftWiper = Math.round(lAngleRad * (180 / Math.PI));

    // 右脚すねの垂直に対する傾斜角
    const rdx = rAnkle.x - rKnee.x;
    const rdy = rAnkle.y - rKnee.y;
    const rAngleRad = Math.atan2(Math.abs(rdx), Math.abs(rdy));
    const rightWiper = Math.round(rAngleRad * (180 / Math.PI));

    return {
      main: leftWiper,
      sub: rightWiper,
      diff: Math.abs(leftWiper - rightWiper)
    };
  },

  /**
   * 📐 もも裏ヒンジテスト（片脚前屈・ヒップヒンジ）
   * 肩(11/12)と腰/股関節(23/24)の体幹前傾ベクトル角（鉛直に対する前傾角度）
   */
  calcHamstringHinge(rawLm) {
    const ls = rawLm[11];
    const rs = rawLm[12];
    const lh = rawLm[23];
    const rh = rawLm[24];

    if (!ls || !rs || !lh || !rh) return { main: 0, sub: 0, diff: 0 };

    // 体幹中点（肩の中点と腰の中点）
    const midShoulder = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const midHip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };

    const dx = midShoulder.x - midHip.x;
    const dy = midShoulder.y - midHip.y;

    // 鉛直軸に対する前傾角
    const hingeRad = Math.atan2(Math.abs(dx), Math.abs(dy));
    const hingeDeg = Math.round(hingeRad * (180 / Math.PI));

    return {
      main: hingeDeg,
      sub: hingeDeg,
      currentAngle: hingeDeg
    };
  },

  /**
   * カンニング（代償動作・浮き上がり）の検知
   * 回旋時にお尻（腰のY座標）が基準値から急激に浮き上がったら警告
   */
  detectCheat(rawLm) {
    const lh = rawLm[23];
    const rh = rawLm[24];
    if (!lh || !rh) return { detected: false, reason: '' };

    const currentHipY = (lh.y + rh.y) / 2;

    // 基準腰高の初回キャリブレーション
    if (this.baseHipY === null || !this.baselineCalibrated) {
      this.baseHipY = currentHipY;
      this.baselineCalibrated = true;
      return { detected: false, reason: '' };
    }

    // Y座標が小さくなる ＝ 身体が上方に浮き上がっている
    const hipLiftAmount = this.baseHipY - currentHipY;

    // 画面比率で5%以上の浮き上がりをお尻浮き（カンニング）と判定
    if (hipLiftAmount > 0.055) {
      return {
        detected: true,
        reason: 'お尻が浮いています！骨盤を床につけて回旋しよう'
      };
    }

    return { detected: false, reason: '' };
  },

  /**
   * キャリブレーションの再設定（測定開始時に呼出）
   */
  resetCalibration() {
    this.baseHipY = null;
    this.baselineCalibrated = false;
  },

  /**
   * 補正済み座標系で骨格線・関節ポイントを描画
   */
  drawSkeleton(pts) {
    const ctx = this.ctx;

    // 接続する骨格ペア一覧
    const connections = [
      [11, 12], // 両肩
      [11, 13], [13, 15], // 左腕
      [12, 14], [14, 16], // 右腕
      [11, 23], [12, 24], // 体幹側部
      [23, 24], // 腰
      [23, 25], [25, 27], // 左脚
      [24, 26], [26, 28]  // 右脚
    ];

    ctx.save();
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.85)'; // シアン基調

    connections.forEach(([i, j]) => {
      const p1 = pts[i];
      const p2 = pts[j];
      if (p1 && p2 && p1.visibility > 0.4 && p2.visibility > 0.4) {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    });

    // 関節ポイントのハイライト描画
    pts.forEach((p, idx) => {
      if (p && p.visibility > 0.4) {
        // 主要関節（肩・肘・手首・腰・膝・足首）を強調
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
