import { useCallback, useEffect } from 'react';
import { pageFromPath, pathForPage } from './routes';

/**
 * Sync React page state with the browser History API.
 * Returns navigate(page, options, { replace }) that updates state + URL.
 */
export function usePathRouting({ currentPage, setCurrentPage, setPageOptions, setPreviousPage }) {
  const navigate = useCallback(
    (page, options = {}, { replace = false } = {}) => {
      if (page === 'risk-disclosure') {
        setPreviousPage(prev => (currentPage === 'risk-disclosure' ? prev : currentPage));
      }
      setPageOptions(options || {});
      setCurrentPage(page);

      const path = pathForPage(page);
      const method = replace ? 'replaceState' : 'pushState';
      if (replace || window.location.pathname !== path || window.location.search) {
        window.history[method]({ page, options }, '', path);
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [currentPage, setCurrentPage, setPageOptions, setPreviousPage]
  );

  useEffect(() => {
    const onPopState = event => {
      const page = event.state?.page || pageFromPath(window.location.pathname);
      const options = event.state?.options || {};
      setPageOptions(options);
      setCurrentPage(page);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setCurrentPage, setPageOptions]);

  return navigate;
}
