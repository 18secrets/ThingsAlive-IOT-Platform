import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';

/**
 * Translations, set up as in the 1.0 platform (iot_platform/src/i18n.js): one JSON
 * file per language under public/locales, loaded on demand, the choice remembered in
 * localStorage. 1.0 also guessed the language from the browser's location by sending
 * its coordinates to OpenStreetMap; that is left out here — it asks for location
 * permission at sign-in and hands a third party where every user is.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'hi', label: 'हिन्दी', short: 'HI' },
  { code: 'ta', label: 'தமிழ்', short: 'TA' },
  { code: 'te', label: 'తెలుగు', short: 'TE' },
  { code: 'or', label: 'ଓଡ଼ିଆ', short: 'OR' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    supportedLngs: LANGUAGES.map((l) => l.code),
    // `hi-IN` from the browser resolves to `hi` rather than falling back to English.
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    backend: { loadPath: '/locales/{{lng}}/translation.json' },
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'] },
    // A key missing from a language shows the English text, never the bare key.
    returnEmptyString: false,
  });

// Screen readers and the browser's own font choice follow the selected language.
i18n.on('languageChanged', (lng) => { document.documentElement.lang = lng; });

export default i18n;
