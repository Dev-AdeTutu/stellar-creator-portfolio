// CoreHaptics vocabulary for micro-interaction events with accessibility (no-haptics) fallback
export type HapticPattern = 'transient' | 'continuous' | 'success' | 'warning' | 'error' | 'selection';

export interface HapticConfig {
  enabled: boolean;
  intensity: number;   // 0.0 – 1.0
  sharpness: number;   // 0.0 – 1.0
  duration?: number;   // ms, continuous patterns only
}

const PATTERNS: Record<HapticPattern, HapticConfig> = {
  transient:  { enabled: true, intensity: 0.6, sharpness: 0.8 },
  continuous: { enabled: true, intensity: 0.5, sharpness: 0.3, duration: 200 },
  success:    { enabled: true, intensity: 0.9, sharpness: 0.9 },
  warning:    { enabled: true, intensity: 0.7, sharpness: 0.5 },
  error:      { enabled: true, intensity: 1.0, sharpness: 1.0 },
  selection:  { enabled: true, intensity: 0.4, sharpness: 0.6 },
};

let accessibilityNoHaptics = false;

export function setNoHapticsMode(disabled: boolean): void {
  accessibilityNoHaptics = disabled;
}

// Trigger a named haptic pattern; no-ops when accessibility disables haptics.
// Delegates to native HapticBridge resolved at runtime.
export function triggerHaptic(pattern: HapticPattern): void {
  if (accessibilityNoHaptics) return;
  const config = PATTERNS[pattern];
  const bridge = (globalThis as any).HapticBridge;
  if (typeof bridge?.play === 'function') {
    bridge.play(config);
  }
}

export function getPatternConfig(pattern: HapticPattern): HapticConfig {
  return PATTERNS[pattern];
}
