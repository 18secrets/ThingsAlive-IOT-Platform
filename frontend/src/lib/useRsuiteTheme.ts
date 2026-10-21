import { useEffect, useState } from 'react';

/**
 * Mirrors the `dark` class Shell.tsx already toggles on <html> — a
 * MutationObserver rather than shared state, so rsuite's theme follows the
 * existing toggle regardless of where in the tree it fires from.
 */
export function useRsuiteTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
