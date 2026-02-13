class TTSManager {
    constructor() {
        this.audioCtx = null;
        this.activeUtterances = new Set();
        this.initAudioContext();
    }

    initAudioContext() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                this.audioCtx = new AudioContext();
            }
        } catch (e) {
            console.warn('AudioContext not supported or failed to init', e);
        }
    }

    /**
     * ハードウェアのWakeUpを行う (Fire-and-forget推奨)
     * iOSや一部のAndroid、省電力モードのPCで、音声出力の頭出しが遅れるのを防ぐ
     */
    async wakeUp() {
        if (!this.audioCtx) return;

        try {
            if (this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }

            // 無音のオシレーターを一瞬鳴らす
            const oscillator = this.audioCtx.createOscillator();
            const gainNode = this.audioCtx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioCtx.destination);

            oscillator.frequency.value = 1; // 1Hz (ほぼ聞こえない)
            gainNode.gain.value = 0.001; // 極小音量

            oscillator.start();
            await new Promise(r => setTimeout(r, 100)); // 100ms再生
            oscillator.stop();

            // クリーンアップ
            setTimeout(() => {
                oscillator.disconnect();
                gainNode.disconnect();
            }, 100);

        } catch (e) {
            console.warn('WakeUp failed:', e);
        }
    }

    /**
     * 音声合成を行う
     * @param {string} text 読み上げるテキスト
     * @param {string} lang 言語コード (例: 'zh-TW', 'en-US')
     * @param {number} rate 読み上げ速度 (0.1 ~ 10, default 1.0)
     * @returns {Promise<void>} 読み上げ完了またはタイムアウトでresolve
     */
    async speak(text, lang = 'en-US', rate = 1.0) {
        // 1. 直前の再生をキャンセル
        window.speechSynthesis.cancel();

        // 2. Hardware WakeUp (待たない)
        this.wakeUp().catch(e => console.warn(e));

        // 3. テキスト処理 (冒頭欠け対策)
        // 特定の言語、あるいは全言語でパディングを入れる
        // 「。」や「 」などを先頭に入れると、エンジンが準備運動してから本題に入れる
        let textToSpeak = text;

        // 台湾中国語などで顕著なため、パディングを追加
        // 特にWindowsのSAPI5系などで効果がある
        if (lang === 'zh-TW') {
            // テキストの前に読点とスペースを入れる（エンジンによっては無視されるが、効果がある場合が多い）
            textToSpeak = '... ' + text;
        } else {
            // 他言語でも念のため、極短の無音的なものを入れる
            // ただ、あまり長くするとテンポが悪くなるのでコンマ1つ程度
            textToSpeak = ', ' + text;
        }

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.lang = lang;
        utterance.rate = rate;

        // 音声選択
        const voices = window.speechSynthesis.getVoices();
        let voice = null;
        if (lang === 'zh-TW') {
            // 優先: Zhiwei (Microsoft), Hanhan (Microsoft), その他
            voice = voices.find(v => v.lang === 'zh-TW' && (v.name.includes('Zhiwei') || v.name.includes('Hanhan')))
                || voices.find(v => v.lang === 'zh-TW');
        } else {
            voice = voices.find(v => v.lang === lang);
        }
        if (voice) utterance.voice = voice;

        // 4. 再生実行とPromise管理
        return new Promise((resolve) => {
            // GC対策
            this.activeUtterances.add(utterance);

            // 安全装置: 最大でも (文字数 * 0.5秒 + 3秒) 経ったら強制終了
            // これにより、もしイベントが来なくても次へ進める
            const timeoutMs = (text.length * 500) + 3000;
            const timeoutId = setTimeout(() => {
                console.warn('TTS Timeout:', text);
                cleanup();
                resolve();
            }, timeoutMs);

            const cleanup = () => {
                clearTimeout(timeoutId);
                this.activeUtterances.delete(utterance);
            };

            utterance.onend = () => {
                cleanup();
                resolve();
            };

            utterance.onerror = (e) => {
                console.error('TTS Error:', e);
                cleanup();
                resolve();
            };

            // ブラウザのバグでonendが呼ばれないことがあるため、onboundaryも監視して
            // 最後の単語が終わったか推測する手もあるが、今回はタイムアウトでカバーする

            window.speechSynthesis.speak(utterance);
        });
    }

    getVoices() {
        return window.speechSynthesis.getVoices();
    }
}
