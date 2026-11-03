/**
 * Services - 業務邏輯服務層
 */

// 加密服務
export * from './crypto';
export { default as crypto } from './crypto';

// MQTT 服務
export * from './mqtt';
export { default as mqtt } from './mqtt';

// WebRTC 服務
export * from './webrtc';
export { default as webrtc } from './webrtc';

// 語音通話服務
export * from './voiceCall';
export { default as voiceCall } from './voiceCall';

// 防詐（規則引擎、語音分析、規則同步、語音辨識、特徵提取）是官方版的功能：在 src/ext-official/antiFraud，經 ext.antiFraud 使用
