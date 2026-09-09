// biomechanics.js - しなり・柔軟性計算モジュール
export class BiomechanicsCalc {
    constructor() {
        // 本来はMediaPipe等の姿勢推定座標(landmarks)を保持する
    }

    // モック用の測定シミュレーション
    // ※実際はMediaPipeの landmarks を受け取り、肩峰と上前腸骨棘の角度差を計算
    simulateMeasurement(progressCallback, completeCallback) {
        let progress = 0;
        const interval = setInterval(() => {
            progress += 2;
            progressCallback(progress);
            
            if (progress >= 100) {
                clearInterval(interval);
                const result = this._generateScore();
                completeCallback(result);
            }
        }, 50);
    }

    _generateScore() {
        // テスト用にランダムなスコアを生成（ドリルの前後は本来比較を行う）
        const thoracicAngle = Math.floor(Math.random() * 40) + 40; // 40~80度
        const hipSeparation = Math.floor(Math.random() * 50) + 50; // 50~100%

        let rank = "";
        let feedback = "";

        if (thoracicAngle >= 70 && hipSeparation >= 90) {
            rank = "🌟 SUPER DRAGON達成！";
            feedback = "背骨と股関節が完全に分離しちょる！剛速球の準備完了！";
        } else if (thoracicAngle >= 60 && hipSeparation >= 70) {
            rank = "⚡ LEVEL 2 実戦しなりマスター";
            feedback = "かなり良い動き！さらなる覚醒を目指せ！";
        } else if (thoracicAngle >= 50) {
            rank = "🔒 あと少しで覚醒！";
            feedback = "惜しい！腰も一緒に回ってしまっとるぞ！";
        } else {
            rank = "⚠️ カチコチ要解除";
            feedback = "サビつき確認！今すぐドリルで胸椎を動かそう！";
        }

        return { thoracicAngle, hipSeparation, rank, feedback };
    }
}
