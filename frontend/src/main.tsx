import {StrictMode, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {CustomProvider} from 'rsuite';
import App from './App.tsx';
import {MutationToasts} from './components/common/MutationToasts';
import {useRsuiteTheme} from './lib/useRsuiteTheme';
import {useRsuiteLocale} from './lib/useRsuiteLocale';
// rsuite's own CSS loads first, so a Tailwind utility (e.g. `pl-9` clearing a
// search icon) wins any same-specificity tie against rsuite's own component
// defaults (e.g. `.rs-input`'s padding) — the standard rsuite+Tailwind order.
import 'rsuite/dist/rsuite-no-reset.css';
import './index.css';
// Loads the chosen language's file before the first render, so nothing flashes in English.
import './i18n';

const Root = () => {
  const theme = useRsuiteTheme();
  const locale = useRsuiteLocale();
  return (
    <CustomProvider theme={theme} locale={locale}>
      <Suspense fallback={null}>
        <App />
        <MutationToasts />
      </Suspense>
    </CustomProvider>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
