import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {CustomProvider} from 'rsuite';
import App from './App.tsx';
import {useRsuiteTheme} from './lib/useRsuiteTheme';
// rsuite's own CSS loads first, so a Tailwind utility (e.g. `pl-9` clearing a
// search icon) wins any same-specificity tie against rsuite's own component
// defaults (e.g. `.rs-input`'s padding) — the standard rsuite+Tailwind order.
import 'rsuite/dist/rsuite-no-reset.css';
import './index.css';

const Root = () => {
  const theme = useRsuiteTheme();
  return (
    <CustomProvider theme={theme}>
      <App />
    </CustomProvider>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
