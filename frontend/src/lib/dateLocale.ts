import i18n from '../i18n';

/**
 * The locale every date and time on screen is written in: the reader's chosen language,
 * in India. Left to the browser, an English-US browser wrote the India fleet's dates
 * month first ("11/4/2026"), and a reader who picked Hindi still got US English dates
 * (test report MIN-12). en-IN writes day first; hi-IN, ta-IN, te-IN and or-IN write the
 * language's own month and day names.
 *
 * Dates only: numbers keep the browser's grouping, so a figure like 100,000 is not
 * rewritten as 1,00,000 behind the reader's back.
 */
export function appLocale(): string {
  const lang = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
  return `${lang}-IN`;
}
