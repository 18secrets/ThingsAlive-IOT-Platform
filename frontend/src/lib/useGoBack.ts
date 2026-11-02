import { useNavigate } from 'react-router-dom';

/**
 * Back to where the viewer came from, inside the app — Go Back on a machine page
 * opened from the dashboard returned to the equipment list instead (test report
 * COS-6). React Router numbers its own history entries (`history.state.idx`), so an
 * index above 0 means there is an in-app page to return to; a page opened from a
 * link or a new tab has none and goes to `fallback`, its list.
 */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof idx === 'number' && idx > 0) navigate(-1);
    else navigate(fallback);
  };
}
