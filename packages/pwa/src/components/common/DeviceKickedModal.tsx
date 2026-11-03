/**
 * DeviceKickedModal — 帳號在新裝置登入提示
 *
 * Phase 35a/b:
 *  - 偵測到帳號被新裝置宣告時顯示
 *  - 5 秒倒數後自動 reload 回 AuthScreen
 *  - 使用者可點按鈕立即 reload（金鑰已在 AppProvider 清除）
 */

import { useEffect, useState } from 'react';

const AUTO_RELOAD_SECONDS = 5;

export function DeviceKickedModal() {
  const [show, setShow] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_RELOAD_SECONDS);

  useEffect(() => {
    const handler = () => setShow(true);
    window.addEventListener('aegis:device-kicked', handler);
    return () => window.removeEventListener('aegis:device-kicked', handler);
  }, []);

  useEffect(() => {
    if (!show) return;
    if (countdown <= 0) {
      window.location.reload();
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [show, countdown]);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
      <div className="bg-surface-secondary rounded-2xl max-w-md w-full shadow-2xl overflow-hidden">
        {/* 標題 */}
        <div className="bg-orange-500 text-white px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m0 0a2 2 0 100 4 2 2 0 000-4zm0 0V9m0 0a4 4 0 014 4M5 8a7 7 0 0114 0v2a2 2 0 002 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 002-2V8z"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold">您已在新裝置登入</h2>
              <p className="text-white/80 text-sm">此裝置已被自動登出</p>
            </div>
          </div>
        </div>

        {/* 內容 */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-on-surface-primary leading-relaxed">
            為保障您的帳號安全，AegisTalk 同一帳號只允許一台裝置同時登入。
          </p>
          <p className="text-on-surface-secondary text-sm leading-relaxed">
            本機金鑰已被清除。如果您正在使用新裝置，可以忽略此訊息。
            <br />
            如果這不是您本人的操作，請立即聯繫我們並重新註冊。
          </p>
          <p className="text-on-surface-tertiary text-xs">
            {countdown} 秒後將自動返回登入畫面…
          </p>
        </div>

        {/* 按鈕 */}
        <div className="px-6 pb-6">
          <button
            onClick={() => window.location.reload()}
            className="w-full py-3 px-4 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600 transition-colors"
          >
            立即返回登入畫面
          </button>
        </div>
      </div>
    </div>
  );
}

export default DeviceKickedModal;
