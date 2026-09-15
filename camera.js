(function() {
  'use strict';

  const CameraEngine = {
    videoElement: null,
    currentFacingMode: 'user',
    isRunning: false,
    isSwitchingCamera: false,
    animationFrameId: null,

    init({ videoElement }) {
      this.videoElement = videoElement;
    },

    async start({ onFrame, onStarted, onError }) {
      if (!this.videoElement) {
        onError && onError(new Error('videoElement is not set'));
        return;
      }

      try {
        await this.stop();
        await new Promise(resolve => setTimeout(resolve, 80));

        let stream = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { exact: this.currentFacingMode },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          });
        } catch (_) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: this.currentFacingMode,
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          });
        }

this.videoElement.srcObject = stream;
this.videoElement.setAttribute('playsinline', 'true');
this.videoElement.setAttribute('webkit-playsinline', 'true');
this.videoElement.muted = true;

try {
  await this.videoElement.play();
} catch (playErr) {
  // iOSの自動再生制限対策:
  // 最初のユーザー操作（ボタンタップ）後に再試行される想定
  console.warn('video.play() blocked, waiting for user gesture:', playErr);
}

        this.isRunning = true;
        onStarted && onStarted();
        this.startLoop(onFrame);
      } catch (err) {
        this.isRunning = false;
        onError && onError(err);
      }
    },

    startLoop(onFrame) {
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }

      let isProcessing = false;

      const tick = async () => {
        if (!this.isRunning) return;

        if (!isProcessing && typeof onFrame === 'function') {
          isProcessing = true;
          try {
            await onFrame();
          } catch (_) {
            // noop
          } finally {
            isProcessing = false;
          }
        }

        if (this.isRunning) {
          this.animationFrameId = requestAnimationFrame(tick);
        }
      };

      this.animationFrameId = requestAnimationFrame(tick);
    },

    async switchCamera({ onFrame, onStarted, onError }) {
      if (this.isSwitchingCamera) return this.currentFacingMode;
      this.isSwitchingCamera = true;

      try {
        this.currentFacingMode = this.currentFacingMode === 'user' ? 'environment' : 'user';
        await this.start({ onFrame, onStarted, onError });
      } finally {
        this.isSwitchingCamera = false;
      }

      return this.currentFacingMode;
    },

    async stop() {
      this.isRunning = false;

      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }

      if (this.videoElement && this.videoElement.srcObject) {
        const stream = this.videoElement.srcObject;
        const tracks = stream.getTracks();
        tracks.forEach(track => track.stop());
        this.videoElement.srcObject = null;
      }
    },

    getFacingMode() {
      return this.currentFacingMode;
    }
  };

  window.CameraEngine = CameraEngine;
})();
