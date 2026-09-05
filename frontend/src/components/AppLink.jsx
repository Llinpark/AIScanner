import { pathForPage } from '../seo/routes';

/**
 * Crawlable in-app link: real href for SEO, client navigate on click.
 */
export default function AppLink({
  page,
  options,
  onNavigate,
  className = '',
  children,
  ariaCurrent,
  ariaLabel,
  replace = false
}) {
  const href = pathForPage(page);

  const handleClick = event => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }
    event.preventDefault();
    if (onNavigate) {
      onNavigate(page, options || {}, { replace });
    }
  };

  return (
    <a
      href={href}
      className={className}
      onClick={handleClick}
      aria-current={ariaCurrent}
      aria-label={ariaLabel}
    >
      {children}
    </a>
  );
}
