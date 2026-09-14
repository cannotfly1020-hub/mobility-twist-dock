(function() {
  'use strict';

  let sleepTimerId = null;
  let isSleepMode = false;
  let sleepListenersAttached = false;
  const SLEEP_TIMEOUT_MS = 3 * 60 * 1000; // 3分

  function resetSleepTimer() {
    if (sleepTimerId) {
      clearTimeout(sleepTimerId);
    }

    if (isSleepMode) {
      return;
    }

    sleepTimerId = setTimeout(() => {
      enterSleepMode();
    }, SLEEP_TIMEOUT_MS);
  }

  function enterSleepMode() {
    if (isSleepMode) return;

    isSleepMode = true;

    if (window.AppEngine && typeof window.AppEngine.stop === 'function') {
      window.AppEngine.stop();
    }

    const canvasElement = window.AppEngine?.getCanvasElement?.();
    const canvasCtx = window.AppEngine?.getCanvasContext?.();

    if (canvasCtx && canvasElement) {
      canvasCtx.save();
      canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
      canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
      canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);
      canvasCtx.fillStyle = '#ffffff';
      canvasCtx.font = 'bold 28px sans-serif';
      canvasCtx.textAlign = 'center';
      canvasCtx.textBaseline = 'middle';
      canvasCtx.fillText('スリープ中', canvasElement.width / 2, canvasElement.height / 2);
      canvasCtx.restore();
    }
  }

  async function exitSleepMode() {
    if (!isSleepMode) return;

    isSleepMode = false;
    resetSleepTimer();

    if (window.AppEngine && typeof window.AppEngine.startCamera === 'function') {
      await window.AppEngine.startCamera();
    }
  }

  window.SleepManager = {
    resetSleepTimer,
    enterSleepMode,
    exitSleepMode,
    get isSleepMode() {
      return isSleepMode;
    },
    get sleepListenersAttached() {
      return sleepListenersAttached;
    },
    setSleepListenersAttached(value) {
      sleepListenersAttached = value;
    }
  };
})();
