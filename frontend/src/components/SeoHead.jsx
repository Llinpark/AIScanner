import { useEffect } from 'react';
import { getPageMeta } from '../seo/pageMeta';

function upsertMeta(selector, attributes) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement(attributes.property || attributes.name ? 'meta' : 'meta');
    if (attributes.name) el.setAttribute('name', attributes.name);
    if (attributes.property) el.setAttribute('property', attributes.property);
    document.head.appendChild(el);
  }
  Object.entries(attributes).forEach(([key, value]) => {
    if (key === 'name' || key === 'property') return;
    if (value == null) {
      el.removeAttribute(key);
    } else {
      el.setAttribute(key, value);
    }
  });
  return el;
}

function upsertLink(rel, href) {
  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
  return el;
}

const JSON_LD_ID = 'kaching-jsonld';

export default function SeoHead({ page }) {
  useEffect(() => {
    const meta = getPageMeta(page);

    document.title = meta.title;

    upsertMeta('meta[name="description"]', { name: 'description', content: meta.description });
    upsertMeta('meta[name="keywords"]', { name: 'keywords', content: meta.keywords });
    upsertMeta('meta[name="robots"]', { name: 'robots', content: meta.robots });
    upsertMeta('meta[name="googlebot"]', { name: 'googlebot', content: meta.robots });
    upsertLink('canonical', meta.canonical);

    upsertMeta('meta[property="og:type"]', { property: 'og:type', content: meta.ogType });
    upsertMeta('meta[property="og:url"]', { property: 'og:url', content: meta.ogUrl });
    upsertMeta('meta[property="og:title"]', { property: 'og:title', content: meta.ogTitle });
    upsertMeta('meta[property="og:description"]', {
      property: 'og:description',
      content: meta.ogDescription
    });
    upsertMeta('meta[property="og:image"]', { property: 'og:image', content: meta.ogImage });
    upsertMeta('meta[property="og:site_name"]', {
      property: 'og:site_name',
      content: meta.ogSiteName
    });

    upsertMeta('meta[name="twitter:card"]', { name: 'twitter:card', content: meta.twitterCard });
    upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: meta.twitterTitle });
    upsertMeta('meta[name="twitter:description"]', {
      name: 'twitter:description',
      content: meta.twitterDescription
    });
    upsertMeta('meta[name="twitter:image"]', {
      name: 'twitter:image',
      content: meta.twitterImage
    });

    let script = document.getElementById(JSON_LD_ID);
    if (meta.jsonLd) {
      if (!script) {
        script = document.createElement('script');
        script.type = 'application/ld+json';
        script.id = JSON_LD_ID;
        document.head.appendChild(script);
      }
      script.textContent = JSON.stringify(meta.jsonLd);
    } else if (script) {
      script.remove();
    }
  }, [page]);

  return null;
}
