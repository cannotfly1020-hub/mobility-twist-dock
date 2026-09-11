class PoseEngine {
    constructor() {
        this.video = document.getElementById('videoElement');
        this.canvas = document.getElementById('canvasOverlay');
        this.ctx = this.canvas.getContext('2d');
        
        this.pose = new Pose({locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
        }});
        
        this.pose.setOptions({
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.7,
            minTrackingConfidence: 0.7
        });

        this.pose.onResults(this.onResults.bind(this));
        
        this.camera = null;
        this.currentMode = null;
        this.onPoseUpdate = null; // Callback for app.js
        this.aspectBounds = { x:0, y:0, w:0, h:0 };
        this.isFrontCamera = true;
    }

    async startCamera() {
        if (this.camera) return;
        
        try {
            this.camera = new Camera(this.video, {
                onFrame: async () => {
                    await this.pose.send({image: this.video});
                },
                width: 640,
                height: 480,
                facingMode: 'user'
            });
            await this.camera.start();
            this.resizeCanvas();
            window.addEventListener('resize', () => this.resizeCanvas());
        } catch (error) {
            console.error("Camera access failed:", error);
            alert("カメラへのアクセスが拒否されました。");
        }
    }

    stopCamera() {
        if (this.camera) {
            this.camera.stop();
            this.camera = null;
        }
    }

    setMode(mode, callback) {
        this.currentMode = mode;
        this.onPoseUpdate = callback;
    }

    resizeCanvas() {
        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;
        this.aspectBounds = this.getAspectFitBounds(
            this.video.videoWidth || 640, 
            this.video.videoHeight || 480, 
            this.canvas.width, 
            this.canvas.height
        );
    }

    // Calculates exactly where the object-fit: cover video is rendered on the canvas
    getAspectFitBounds(videoW, videoH, containerW, containerH) {
        const videoRatio = videoW / videoH;
        const containerRatio = containerW / containerH;
        let renderW, renderH, offsetX, offsetY;

        if (containerRatio > videoRatio) {
            renderW = containerW;
            renderH = containerW / videoRatio;
            offsetX = 0;
            offsetY = (containerH - renderH) / 2;
        } else {
            renderH = containerH;
            renderW = containerH * videoRatio;
            offsetX = (containerW - renderW) / 2;
            offsetY = 0;
        }
        return { w: renderW, h: renderH, x: offsetX, y: offsetY };
    }

    // Convert normalized MediaPipe coordinates (0-1) to actual canvas pixel coordinates based on aspect bounds
    toPixel(normX, normY) {
        // Since the canvas itself has transform: scale-x(-1), we draw normally, and CSS handles the mirror.
        const px = this.aspectBounds.x + normX * this.aspectBounds.w;
        const py = this.aspectBounds.y + normY * this.aspectBounds.h;
        return { x: px, y: py };
    }

    calcAngle2D(v1, v2) {
        const dot = v1.x*v2.x + v1.y*v2.y;
        const mag1 = Math.hypot(v1.x, v1.y);
        const mag2 = Math.hypot(v2.x, v2.y);
        if (mag1 === 0 || mag2 === 0) return 0;
        return Math.acos(dot / (mag1 * mag2)) * (180 / Math.PI);
    }

    calcVector(pStart, pEnd) {
        return { x: pEnd.x - pStart.x, y: pEnd.y - pStart.y };
    }

    midPoint(p1, p2) {
        return { x: (p1.x + p2.x)/2, y: (p1.y + p2.y)/2, visibility: Math.min(p1.visibility, p2.visibility) };
    }

    drawSkeleton(lm) {
        this.ctx.lineWidth = 4;
        const drawLine = (i, j, color = '#38bdf8') => {
            if(lm[i].visibility < 0.6 || lm[j].visibility < 0.6) return;
            const p1 = this.toPixel(lm[i].x, lm[i].y);
            const p2 = this.toPixel(lm[j].x, lm[j].y);
            this.ctx.beginPath();
            this.ctx.strokeStyle = color;
            this.ctx.moveTo(p1.x, p1.y);
            this.ctx.lineTo(p2.x, p2.y);
            this.ctx.stroke();
        };
        
        // Torso
        drawLine(11, 12); drawLine(11, 23); drawLine(12, 24); drawLine(23, 24);
        // Arms
        drawLine(11, 13); drawLine(13, 15); drawLine(12, 14); drawLine(14, 16);
        // Legs
        drawLine(23, 25); drawLine(25, 27); drawLine(24, 26); drawLine(26, 28);
    }

    onResults(results) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        if (!results.poseLandmarks) {
            if (this.onPoseUpdate) this.onPoseUpdate({ state: 'NO_POSE' });
            return;
        }

        const lm = results.poseLandmarks;
        this.drawSkeleton(lm);

        if (!this.currentMode || !this.onPoseUpdate) return;

        let measurements = {};
        let isReady = false;
        let warning = null;

        // 1. Face & Setup Detection
        const nose = lm[0];
        const leftEar = lm[7];
        const rightEar = lm[8];
        const faceVis = nose.visibility > 0.7;

        // Common calculations
        const lShoulder = lm[11], rShoulder = lm[12];
        const lHip = lm[23], rHip = lm[24];
        const lKnee = lm[25], rKnee = lm[26];
        const lAnkle = lm[27], rAnkle = lm[28];
        const lElbow = lm[13], rElbow = lm[14];
        const lWrist = lm[15], rWrist = lm[16];

        switch(this.currentMode) {
            case 'hip': {
                // 正面: 股関節内外旋 (ワイパー)
                const faceRatio = (nose.x - rightEar.x) / (leftEar.x - rightEar.x + 0.001); // 0.3-0.7
                const isFacingFront = faceVis && faceRatio > 0.3 && faceRatio < 0.7;
                
                // 腰の水平チェック (カンニング検知)
                const hipYDiff = Math.abs(lHip.y - rHip.y) * this.aspectBounds.h;
                if (hipYDiff > 35) warning = "お尻が浮いてるぞ！";

                // 膝曲げチェック (Y座標が足首より上、ある程度離れている)
                const isSitting = lKnee.y < lAnkle.y - 0.05 && rKnee.y < rAnkle.y - 0.05;

                isReady = isFacingFront && isSitting;

                // Angle calc: 鉛直線(dx=0, dy>0) と 膝->足首ベクトルのなす角
                const calcWiper = (knee, ankle) => {
                    const dx = ankle.x - knee.x;
                    const dy = ankle.y - knee.y;
                    // atan2(dx, dy) => y is down in image coords. 0 means straight down.
                    let ang = Math.atan2(Math.abs(dx), dy) * (180 / Math.PI);
                    return Math.max(0, Math.round(ang));
                };

                measurements = {
                    left: calcWiper(lKnee, lAnkle),
                    right: calcWiper(rKnee, rAnkle)
                };
                break;
            }
            case 'shoulder_flex': {
                // 正面: 両腕バンザイ
                const faceRatio = (nose.x - rightEar.x) / (leftEar.x - rightEar.x + 0.001);
                const isFacingFront = faceVis && faceRatio > 0.3 && faceRatio < 0.7;
                
                // 構え: 手が肩より下にあること
                const handsDown = lWrist.y > lShoulder.y && rWrist.y > rShoulder.y;
                isReady = isFacingFront && handsDown;

                const midShoulder = this.midPoint(lShoulder, rShoulder);
                const midHip = this.midPoint(lHip, rHip);
                const trunkVec = { x: midShoulder.x - midHip.x, y: midShoulder.y - midHip.y }; // Upwards

                const calcFlex = (shoulder, wrist) => {
                    const armVec = { x: wrist.x - shoulder.x, y: wrist.y - shoulder.y }; // towards wrist
                    // Angle between trunk and arm. If straight up, angle is 0. 
                    // 挙上角度は 180 - なす角
                    const angle = this.calcAngle2D(trunkVec, armVec);
                    return Math.max(0, Math.round(180 - angle));
                };

                measurements = {
                    left: calcFlex(lShoulder, lWrist),
                    right: calcFlex(rShoulder, rWrist)
                };
                break;
            }
            case 'shoulder_gird': {
                // 横向き: 肩2nd内外旋
                // 鼻が片方の肩に近ければ横向きと判定。
                const isRightSide = (nose.x > lShoulder.x); // Assuming camera mirrors
                const activeSide = isRightSide ? {s: rShoulder, e: rElbow, w: rWrist, h: rHip} : {s: lShoulder, e: lElbow, w: lWrist, h: lHip};
                
                // 構え判定: 肘が肩の高さ(Yが近い), 前腕が前(水平) -> 手首が肘より前でYが近い
                const elbowRaised = Math.abs(activeSide.e.y - activeSide.s.y) < 0.1;
                const forearmForward = Math.abs(activeSide.w.y - activeSide.e.y) < 0.15 && Math.abs(activeSide.w.x - activeSide.e.x) > 0.05;
                
                isReady = elbowRaised && forearmForward;

                // Angle: 体幹(Hip->Shoulder) と 前腕(Elbow->Wrist) のなす角
                const trunk = { x: activeSide.s.x - activeSide.h.x, y: activeSide.s.y - activeSide.h.y }; // Upwards
                const forearm = { x: activeSide.w.x - activeSide.e.x, y: activeSide.w.y - activeSide.e.y };
                
                // 90度が前(0度スタート)。上が外旋(正)、下が内旋(負)とするため、
                // 外積や内積で判断。
                const rawAngle = this.calcAngle2D(trunk, forearm); // 0(上)〜180(下)
                // 前腕が前を向いている時、trunk(上)とforearm(横)の角度は約90度。
                // 90 - rawAngle => 上(0度)なら90。つまり、天井方向への外旋角度。
                // ただし、厳密には外旋(上)=90, 内旋(下)=-90になるように補正。
                let val = Math.round(90 - rawAngle); 
                
                // 表示用。left/right ではなく、外旋/内旋としてUIに渡すためにオブジェクト構造を合わせる。
                // 今回は横向きなので片腕のみ測定中。App側で最大最小をとってTotal Arcを出す。
                measurements = {
                    val: val,
                    activeSide: isRightSide ? 'RIGHT' : 'LEFT'
                };
                break;
            }
            case 'hamstring': {
                // 横向き: もも裏前屈
                const isRightSide = (nose.x > lShoulder.x); 
                const activeSide = isRightSide ? {s: rShoulder, h: rHip, k: rKnee, a: rAnkle} : {s: lShoulder, h: lHip, k: lKnee, a: lAnkle};
                
                // 構え: 背筋が伸びている(体幹と大腿が90度前後), 膝が伸びている
                const trunk = { x: activeSide.s.x - activeSide.h.x, y: activeSide.s.y - activeSide.h.y };
                const thigh = { x: activeSide.k.x - activeSide.h.x, y: activeSide.k.y - activeSide.h.y };
                const hipAngle = this.calcAngle2D(trunk, thigh);
                
                const shin = { x: activeSide.a.x - activeSide.k.x, y: activeSide.a.y - activeSide.k.y };
                const kneeAngle = this.calcAngle2D(thigh, shin); // 直線なら0

                if (kneeAngle > 20) warning = "膝が曲がってるぞ！";
                
                // 座って直立している状態(hipAngle約90度)
                isReady = hipAngle > 70 && hipAngle < 110 && kneeAngle <= 20;

                // 前傾角度 = 90 - hipAngle (90度が直立、それより鋭角になれば前傾)
                let flexAngle = Math.round(90 - hipAngle);
                if (flexAngle < -10) flexAngle = -10;

                measurements = {
                    val: flexAngle,
                    activeSide: isRightSide ? 'RIGHT' : 'LEFT'
                };
                break;
            }
        }

        this.onPoseUpdate({
            state: 'DETECTED',
            isReady,
            measurements,
            warning
        });
    }
}

window.poseEngine = new PoseEngine();
