/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // AegisTalk 品牌色 - 基於 logo 的深藍青色
        aegis: {
          50: '#e6f7fa',
          100: '#cceff5',
          200: '#99dfeb',
          300: '#66cfe0',
          400: '#4dd0e1',
          500: '#26c6da',
          600: '#00acc1',
          700: '#00838f',
          800: '#006064',
          900: '#004d40',
        },
        mist: {
          50: '#e6f7fa',
          100: '#cceff5',
          200: '#99dfeb',
          300: '#66cfe0',
          400: '#4dd0e1',
          500: '#26c6da',
          600: '#00acc1',
          700: '#00838f',
          800: '#006064',
          900: '#004d40',
        },
        navy: {
          50: '#e8eef5',
          100: '#d1ddeb',
          200: '#a3bbd7',
          300: '#7599c3',
          400: '#4777af',
          500: '#1a3a5c',
          600: '#162f4d',
          700: '#12253e',
          800: '#0e1a2e',
          900: '#0d1b2a',
        },
        // 語義化表面色彩 (CSS 變數驅動)
        surface: {
          primary: 'var(--surface-primary)',
          secondary: 'var(--surface-secondary)',
          tertiary: 'var(--surface-tertiary)',
          elevated: 'var(--surface-elevated)',
          container: 'var(--surface-tertiary)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          soft: 'var(--accent-soft)',
        },
        'on-surface': {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
        },
        // 保留向後兼容
        dark: {
          bg: '#000000',
          card: '#0a0a0a',
          border: '#2a2a2a',
          50: '#f5f5f5',
          100: '#e0e0e0',
          200: '#bdbdbd',
          300: '#9e9e9e',
          400: '#757575',
          500: '#616161',
          600: '#1e3a5c',
          700: '#162f4d',
          800: '#142638',
          900: '#0d1b2a',
        },
        light: {
          bg: '#f8fafc',
          card: '#ffffff',
          border: '#e2e8f0',
          50: '#0d1b2a',
          100: '#1e3a5c',
          200: '#334155',
          300: '#475569',
          400: '#64748b',
          500: '#94a3b8',
          600: '#cbd5e1',
          700: '#e2e8f0',
          800: '#f1f5f9',
          900: '#f8fafc',
        },
        // 官方版的 KYC 畫面、DeviceTransfer / ChatExport / PinKeypad 用的是無色階寫法
        // （bg-primary、text-on-primary、bg-surface-container、text-error、border-outline）。
        // 這些 token 原本沒定義 → Tailwind 直接丟掉那些 class，元件靜默變成無底色純文字
        // （2026-07-28 AegisPay 入金畫面實機發現）。以下補齊，沿用既有 CSS 變數。
        'on-primary': '#04232a',
        error: '#ef4444',
        outline: 'var(--surface-border)',
        primary: {
          DEFAULT: 'var(--accent)',
          50: '#e6f7fa',
          100: '#cceff5',
          200: '#99dfeb',
          300: '#66cfe0',
          400: '#4dd0e1',
          500: '#26c6da',
          600: '#00acc1',
          700: '#00838f',
          800: '#006064',
          900: '#004d40',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'Noto Sans TC',
          'sans-serif',
        ],
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-soft': 'pulseSoft 2s infinite',
        'shake': 'shake 0.5s ease-in-out',
        'ambient-pulse': 'ambientPulse 2.5s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-10px)' },
          '40%': { transform: 'translateX(10px)' },
          '60%': { transform: 'translateX(-10px)' },
          '80%': { transform: 'translateX(10px)' },
        },
        ambientPulse: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
  darkMode: 'class',
}
