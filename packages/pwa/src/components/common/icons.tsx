/**
 * Inline Lucide-style action icons
 *
 * Replaces emoji icons (🗑️ 📋 ↗️ 🔥 📤) in chat UI for:
 *   - Cross-OS visual consistency (Apple Color Emoji vs Noto Color Emoji)
 *   - Theme-color hover support via stroke="currentColor"
 *   - Retina/DPI independence
 *
 * Source: ported from AegisTrans Timeline.tsx
 * See: docs/LEARNINGS_FROM_AEGISTRANS.md §4b
 */

interface IconProps {
  size?: number;
  className?: string;
}

const baseSvgProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function TrashIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

export function CopyIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function ForwardIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <polyline points="15 17 20 12 15 7" />
      <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
    </svg>
  );
}

export function ShareIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

export function FlameIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

// ────────────────────────────────────────────
// 2026-06-12 全 app emoji → 線條 icon 統一（沿用上方同一風格）
// 對應盤點：🔍📎🎤🔇💬👥👤🤖🛡️🔒🔓🚫🔔👑📍⏰⏳✅⚠️❌📥📁📞📵📹📷📱🌐📊📋⚡🔗
//          檔案類型 🖼️📄📝📽️🎵🎬📦📃 + 支付 💰🧧📨 + 狀態圓點 🟢🟡🔴⚪
// ────────────────────────────────────────────

export function SearchIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function PaperclipIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function MicIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

// 說話轉文字（語音輸入）用 — 波形圖示，與「錄音語音訊息」的麥克風圖示區隔
export function AudioLinesIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M2 10v3" />
      <path d="M6 6v11" />
      <path d="M10 3v18" />
      <path d="M14 8v7" />
      <path d="M18 5v13" />
      <path d="M22 10v3" />
    </svg>
  );
}

export function MicOffIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 5.29" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

export function ChatBubbleIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

export function UsersIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function UserIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function BotIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  );
}

export function ShieldIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

export function ShieldAlertIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export function LockIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function UnlockIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

export function BanIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}

export function BellIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function CrownIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
      <path d="M5 21h14" />
    </svg>
  );
}

export function MapPinIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function ClockIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function HourglassIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  );
}

export function CheckCircleIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export function AlertTriangleIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function MaskIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M4 6a2 2 0 0 0-2 2v4a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V8a2 2 0 0 0-2-2h-3a8 8 0 0 0-5 2 8 8 0 0 0-5-2z" />
      <path d="M6 11c1.5 0 2.5.5 3 2" />
      <path d="M18 11c-1.5 0-2.5.5-3 2" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function XIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function XCircleIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export function DownloadIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function FolderIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

export function PhoneIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function PhoneOffIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="22" y1="2" x2="2" y2="22" />
    </svg>
  );
}

export function VideoIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="m22 8-6 4 6 4V8Z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  );
}

export function VideoOffIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196" />
      <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

export function CameraIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

export function SmartphoneIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </svg>
  );
}

export function GlobeIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

export function BarChartIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  );
}

export function ClipboardListIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </svg>
  );
}

export function ZapIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

export function LinkIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

// ── 檔案類型（getFileIcon emoji 對應）──

export function ImageFileIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

export function FileTextIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

export function FileIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

export function PresentationIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M2 3h20" />
      <path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3" />
      <path d="m7 21 5-5 5 5" />
    </svg>
  );
}

export function MusicIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export function FilmIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="2" y1="7" x2="7" y2="7" />
      <line x1="2" y1="17" x2="7" y2="17" />
      <line x1="17" y1="17" x2="22" y2="17" />
      <line x1="17" y1="7" x2="22" y2="7" />
    </svg>
  );
}

export function ArchiveIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

// ── 支付（Payment 元件，feature flag 關閉中仍統一）──

export function WalletIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

export function GiftIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13" />
      <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
    </svg>
  );
}

export function MailIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

// ── 檔案類型 → icon 元件（取代 services/fileShare.ts getFileIcon 的 render 用途；
//    對應規則與 getFileIcon 一一鏡像）──

export function FileTypeIcon({ mimeType, size = 14, className }: IconProps & { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <ImageFileIcon size={size} className={className} />;
  if (mimeType === 'application/pdf') return <FileTextIcon size={size} className={className} />;
  if (mimeType.includes('word') || mimeType.includes('document')) return <FileTextIcon size={size} className={className} />;
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return <BarChartIcon size={size} className={className} />;
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return <PresentationIcon size={size} className={className} />;
  if (mimeType.includes('audio')) return <MusicIcon size={size} className={className} />;
  if (mimeType.includes('video')) return <FilmIcon size={size} className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return <ArchiveIcon size={size} className={className} />;
  if (mimeType.includes('text')) return <FileIcon size={size} className={className} />;
  return <PaperclipIcon size={size} className={className} />;
}

// ── 狀態圓點（🟢🟡🔴⚪🔶 → 實心點 + className 控色，如 text-emerald-400 / text-amber-400）──

export function DotIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden
      className={className}
    >
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}
