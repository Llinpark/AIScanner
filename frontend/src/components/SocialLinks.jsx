import { SOCIAL_LINKS } from '../constants/socialLinks';

export default function SocialLinks({ className = '', variant = 'dark' }) {
  return (
    <div className={`footer-social-links social-links-${variant} ${className}`.trim()}>
      {SOCIAL_LINKS.map(link => (
        <a
          key={link.label}
          href={link.href}
          className="footer-social-link"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={link.label}
        >
          <i className={`bi ${link.icon}`} aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}
