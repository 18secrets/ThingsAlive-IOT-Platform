import { useEffect, useState } from 'react';

/**
 * The reader's text size, beside theme and language (team feedback, 3 Nov 2026): fonts read
 * too small for some, and nothing let a person change it short of browser zoom. It is the
 * root font size (index.css reads --ta-text-size); Tailwind and rsuite size text, spacing
 * and breakpoints in rem, so the whole page follows, as browser zoom would.
 *
 * Remembered per browser in localStorage, like the theme: a preference, not shared state.
 * Every access is guarded — storage can be missing or refused — and Default is used then.
 */
export const TEXT_SIZES = [
  { id: 'small', scale: '87.5%' },
  { id: 'default', scale: '100%' },
  { id: 'large', scale: '112.5%' },
  { id: 'xlarge', scale: '125%' },
] as const;

export type TextSize = (typeof TEXT_SIZES)[number]['id'];

const KEY = 'ta.textSize';
const EVENT = 'ta-text-size';

export function storedTextSize(): TextSize {
  try {
    const saved = localStorage.getItem(KEY);
    return TEXT_SIZES.some((s) => s.id === saved) ? (saved as TextSize) : 'default';
  } catch {
    return 'default';
  }
}

export function applyTextSize(size: TextSize): void {
  const scale = TEXT_SIZES.find((s) => s.id === size)?.scale ?? '100%';
  document.documentElement.style.setProperty('--ta-text-size', scale);
  try { localStorage.setItem(KEY, size); } catch { /* a preference; nothing lost */ }
  // The header picker and the Settings row both show the choice; either one changing it
  // tells the other.
  window.dispatchEvent(new CustomEvent(EVENT, { detail: size }));
}

/** The current choice, kept current wherever it is changed from. */
export function useTextSize(): [TextSize, (size: TextSize) => void] {
  const [size, setSize] = useState<TextSize>(storedTextSize);
  useEffect(() => {
    const on = (e: Event) => setSize((e as CustomEvent<TextSize>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [size, applyTextSize];
}
