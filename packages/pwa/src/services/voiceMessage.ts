import { devLog } from '../utils/devLog';

/**
 * Voice Message Service - 語音訊息服務
 *
 * Phase 9: 支援語音訊息錄製、壓縮與傳送
 *
 * 功能：
 * - 語音錄製 (MediaRecorder API)
 * - 音訊壓縮 (WebM Opus)
 * - Base64 編碼用於 MQTT 傳送
 * - 波形數據提取
 *
 * 注意：語音轉文字和 L2 風險評估已移至接收端 (VoiceMessageBubble)
 */

export interface VoiceRecordingResult {
  /** Base64 編碼的音訊數據 */
  audioData: string;
  /** 音訊時長（秒） */
  duration: number;
  /** MIME 類型 */
  mimeType: string;
  /** 波形數據 (用於 UI 顯示) */
  waveform: number[];
}

export interface VoiceMessageServiceOptions {
  /** 最大錄音時長（秒），預設 60 */
  maxDuration?: number;
  /** 波形取樣數量，預設 50 */
  waveformSamples?: number;
}

type RecordingState = 'idle' | 'recording' | 'processing';

/** 錄音狀態回調 */
type StateCallback = (state: RecordingState) => void;

/** 時長更新回調 */
type DurationCallback = (duration: number) => void;

/** 音量更新回調 */
type VolumeCallback = (volume: number) => void;

class VoiceMessageService {
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startTime: number = 0;
  private waveformData: number[] = [];
  private durationTimer: number | null = null;
  private volumeTimer: number | null = null;
  private maxDuration: number;
  private waveformSamples: number;

  // 回調函數
  private onStateChange: StateCallback | null = null;
  private onDurationUpdate: DurationCallback | null = null;
  private onVolumeUpdate: VolumeCallback | null = null;

  constructor(options: VoiceMessageServiceOptions = {}) {
    this.maxDuration = options.maxDuration || 60;
    this.waveformSamples = options.waveformSamples || 50;
  }

  /**
   * 設定狀態變更回調
   */
  setStateCallback(callback: StateCallback): void {
    this.onStateChange = callback;
  }

  /**
   * 設定時長更新回調
   */
  setDurationCallback(callback: DurationCallback): void {
    this.onDurationUpdate = callback;
  }

  /**
   * 設定音量更新回調
   */
  setVolumeCallback(callback: VolumeCallback): void {
    this.onVolumeUpdate = callback;
  }

  /**
   * 開始錄音
   * 注意：語音轉文字改為接收端處理，發送端只錄製音訊
   */
  async startRecording(): Promise<void> {
    try {
      // 取得麥克風權限
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // 建立 AudioContext 用於音量分析
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      // 確定支援的 MIME 類型
      const mimeType = this.getSupportedMimeType();

      // 建立 MediaRecorder
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType,
        audioBitsPerSecond: 64000, // 64kbps 以節省空間
      });

      this.chunks = [];
      this.waveformData = [];
      this.startTime = Date.now();

      // 監聽數據
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };

      // 開始錄音
      this.mediaRecorder.start(100); // 每 100ms 收集數據

      // 更新狀態
      this.onStateChange?.('recording');

      // 開始時長計時
      this.startDurationTimer();

      // 開始音量監測
      this.startVolumeMonitor();

      // 設定最大時長
      setTimeout(() => {
        if (this.mediaRecorder?.state === 'recording') {
          devLog('[VoiceMessage] Max duration reached, stopping...');
          this.stopRecording();
        }
      }, this.maxDuration * 1000);

      devLog('[VoiceMessage] Recording started');
    } catch (err) {
      console.error('[VoiceMessage] Failed to start recording:', err);
      throw err;
    }
  }

  /**
   * 停止錄音並返回結果
   */
  async stopRecording(): Promise<VoiceRecordingResult | null> {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') {
      return null;
    }

    this.onStateChange?.('processing');

    return new Promise((resolve) => {
      this.mediaRecorder!.onstop = async () => {
        const duration = (Date.now() - this.startTime) / 1000;
        const mimeType = this.mediaRecorder!.mimeType;

        // 合併音訊數據
        const blob = new Blob(this.chunks, { type: mimeType });

        // 轉換為 Base64
        const audioData = await this.blobToBase64(blob);

        // 計算波形
        const waveform = this.normalizeWaveform();

        // 清理資源
        this.cleanup();

        this.onStateChange?.('idle');

        devLog('[VoiceMessage] Recording complete, duration:', duration);

        resolve({
          audioData,
          duration: Math.round(duration * 10) / 10, // 四捨五入到 0.1 秒
          mimeType,
          waveform,
        });
      };

      this.mediaRecorder!.stop();
    });
  }

  /**
   * 取消錄音
   */
  cancelRecording(): void {
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.stop();
    }
    this.cleanup();
    this.onStateChange?.('idle');
    devLog('[VoiceMessage] Recording cancelled');
  }

  /**
   * 取得目前錄音時長（秒）
   */
  getCurrentDuration(): number {
    if (this.startTime === 0) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * 播放語音訊息
   */
  async playVoiceMessage(audioData: string, mimeType: string): Promise<HTMLAudioElement> {
    const blob = this.base64ToBlob(audioData, mimeType);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    audio.onended = () => {
      URL.revokeObjectURL(url);
    };

    audio.onerror = () => {
      URL.revokeObjectURL(url);
    };

    await audio.play();
    return audio;
  }

  /**
   * 取得支援的 MIME 類型
   */
  private getSupportedMimeType(): string {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return 'audio/webm';
  }

  /**
   * Blob 轉 Base64
   */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        // 移除 data URL 前綴
        const base64Data = base64.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Base64 轉 Blob
   */
  private base64ToBlob(base64: string, mimeType: string): Blob {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }

  /**
   * 開始時長計時
   */
  private startDurationTimer(): void {
    this.durationTimer = window.setInterval(() => {
      const duration = this.getCurrentDuration();
      this.onDurationUpdate?.(duration);
    }, 100);
  }

  /**
   * 開始音量監測
   */
  private startVolumeMonitor(): void {
    if (!this.analyser) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const update = () => {
      if (!this.analyser || this.mediaRecorder?.state !== 'recording') {
        return;
      }

      this.analyser.getByteFrequencyData(dataArray);

      // 計算平均音量 (0-1)
      const average = dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;
      const volume = average / 255;

      // 收集波形數據
      this.waveformData.push(volume);

      // 回調音量
      this.onVolumeUpdate?.(volume);

      this.volumeTimer = window.requestAnimationFrame(update);
    };

    update();
  }

  /**
   * 正規化波形數據
   */
  private normalizeWaveform(): number[] {
    if (this.waveformData.length === 0) {
      return new Array(this.waveformSamples).fill(0);
    }

    // 取樣到指定數量
    const result: number[] = [];
    const step = this.waveformData.length / this.waveformSamples;

    for (let i = 0; i < this.waveformSamples; i++) {
      const start = Math.floor(i * step);
      const end = Math.floor((i + 1) * step);
      const slice = this.waveformData.slice(start, end);

      if (slice.length > 0) {
        const avg = slice.reduce((sum, v) => sum + v, 0) / slice.length;
        result.push(Math.round(avg * 100) / 100);
      } else {
        result.push(0);
      }
    }

    return result;
  }

  /**
   * 清理資源
   */
  private cleanup(): void {
    // 停止計時器
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }

    if (this.volumeTimer) {
      cancelAnimationFrame(this.volumeTimer);
      this.volumeTimer = null;
    }

    // 關閉 AudioContext
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // 停止媒體流
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    this.mediaRecorder = null;
    this.analyser = null;
    this.chunks = [];
    this.startTime = 0;
  }

  /**
   * 取得 Blob URL 用於播放
   */
  createPlaybackUrl(audioData: string, mimeType: string): string {
    const blob = this.base64ToBlob(audioData, mimeType);
    return URL.createObjectURL(blob);
  }

  /**
   * 釋放播放 URL
   */
  revokePlaybackUrl(url: string): void {
    URL.revokeObjectURL(url);
  }
}

// 單例導出
export const voiceMessageService = new VoiceMessageService();

// 工具函數：格式化時長
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
