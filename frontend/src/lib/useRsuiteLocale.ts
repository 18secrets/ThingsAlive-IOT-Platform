import { useEffect, useMemo, useState } from 'react';
import i18n from '../i18n';
import enUS from 'rsuite/locales/en_US';

/**
 * rsuite's own built-in text — a picker's "Select" placeholder, its "Search" box,
 * "No results found", date-picker buttons, pagination — in the app's language.
 * rsuite ships no Hindi, Tamil, Telugu or Odia, so its English locale is the base and
 * the words come from translation.json's `rsuite` section. Date patterns and month
 * names stay as rsuite formats them: they come from date-fns, which this app does
 * not depend on directly.
 */
export function useRsuiteLocale() {
  // Subscribed by hand rather than through useTranslation: this runs above the app's
  // Suspense boundary, and on a fresh load the language is already set before its
  // file arrives, so the file's arrival is the change that matters. Until the bundle
  // is in memory, rsuite's own English is the right thing to show.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    i18n.on('languageChanged', bump);
    i18n.on('loaded', bump);
    i18n.store.on('added', bump);
    return () => { i18n.off('languageChanged', bump); i18n.off('loaded', bump); i18n.store.off('added', bump); };
  }, []);
  const lng = i18n.resolvedLanguage ?? i18n.language;
  return useMemo(() => {
    if (!lng || lng === 'en' || !i18n.hasResourceBundle(lng, 'translation')) return enUS;
    const t = i18n.getFixedT(lng, 'translation');
    const r = (k: string) => t(`rsuite.${k}`);
    const days = {
      sunday: r('su'), monday: r('mo'), tuesday: r('tu'), wednesday: r('we'),
      thursday: r('th'), friday: r('fr'), saturday: r('sa'),
      ok: r('ok'), today: r('today'), yesterday: r('yesterday'), now: r('now'),
      hours: r('hours'), minutes: r('minutes'), seconds: r('seconds'),
    };
    const combobox = {
      noResultsText: r('noResultsText'), placeholder: r('placeholder'),
      searchPlaceholder: r('searchPlaceholder'), checkAll: r('checkAll'),
    };
    const creatable = { ...combobox, newItem: r('newItem'), createOption: r('createOption') };
    return {
      ...enUS,
      code: lng,
      common: { loading: r('loading'), emptyMessage: r('emptyMessage'), remove: r('remove'), clear: r('clear') },
      Plaintext: { ...enUS.Plaintext, unfilled: r('unfilled'), notSelected: r('notSelected') },
      Pagination: {
        more: r('more'), prev: r('prev'), next: r('next'), first: r('first'), last: r('last'),
        limit: r('limit'), total: r('total'), skip: r('skip'),
      },
      DateTimeFormats: { ...enUS.DateTimeFormats, ...days },
      Calendar: { ...enUS.Calendar, ...days },
      DatePicker: { ...enUS.DatePicker, ...days },
      DateRangePicker: { ...enUS.DateRangePicker, ...days, last7Days: r('last7Days') },
      Combobox: combobox,
      InputPicker: creatable,
      TagPicker: creatable,
      Uploader: {
        ...enUS.Uploader, progress: r('uploading'), error: r('uploadError'), complete: r('uploadDone'),
        upload: r('upload'), removeFile: r('removeFile'),
      },
      CloseButton: { closeLabel: r('close') },
      Breadcrumb: { expandText: r('showPath') },
      Toggle: { on: r('on'), off: r('off') },
      Dialog: { alert: r('alert'), confirm: r('confirm'), ok: r('ok'), cancel: r('cancel') },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lng, version]);
}
