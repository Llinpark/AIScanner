import { APP_DESCRIPTION, APP_NAME, APP_PAGE_TITLE, APP_TAGLINE, CONTACT_EMAIL, OG_IMAGE_URL, SITE_URL } from '../config/appUrls';
import { pathForPage } from './routes';

const PRIVATE_ROBOTS = 'noindex, nofollow';
const PUBLIC_ROBOTS = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

const KEYWORDS =
  'AI trading, forex signals, SMC signals, TradingView alerts, forex scanner, KachingScanner, market analysis, automated trading';

function absoluteUrl(path) {
  const base = SITE_URL.replace(/\/$/, '');
  if (!path || path === '/') return `${base}/`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function breadcrumb(page, name) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Home',
        item: absoluteUrl('/')
      },
      {
        '@type': 'ListItem',
        position: 2,
        name,
        item: absoluteUrl(pathForPage(page))
      }
    ]
  };
}

function organizationSchema() {
  return {
    '@type': 'Organization',
    '@id': `${absoluteUrl('/')}#organization`,
    name: APP_NAME,
    url: absoluteUrl('/'),
    logo: absoluteUrl('/logo-1.png'),
    email: CONTACT_EMAIL,
    telephone: ['+254745522225', '+254737970108'],
    sameAs: [
      'https://www.tiktok.com/@kachingfx',
      'https://www.instagram.com/kachingfx/',
      'https://www.youtube.com/@kachingfxofficial',
      'https://t.me/KachingFx_Official'
    ]
  };
}

function websiteSchema() {
  return {
    '@type': 'WebSite',
    '@id': `${absoluteUrl('/')}#website`,
    name: APP_NAME,
    url: absoluteUrl('/'),
    description: APP_DESCRIPTION,
    publisher: { '@id': `${absoluteUrl('/')}#organization` },
    inLanguage: 'en'
  };
}

function softwareSchema() {
  return {
    '@type': 'SoftwareApplication',
    name: APP_NAME,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Web',
    url: absoluteUrl('/'),
    description: APP_DESCRIPTION,
    offers: {
      '@type': 'AggregateOffer',
      url: absoluteUrl('/pricing'),
      priceCurrency: 'USD',
      lowPrice: '0',
      offerCount: 3
    },
    publisher: { '@id': `${absoluteUrl('/')}#organization` }
  };
}

export const PRICING_FAQS = [
  {
    question: 'What does a KachingScanner subscription include?',
    answer:
      'Plans unlock AI market analysis, premium SMC-style entry/SL/TP signals, live charts, and TradingView alert setup. Higher tiers add more markets, insights, and automation options.'
  },
  {
    question: 'How do TradingView alerts work with KachingScanner?',
    answer:
      'Subscribers follow the in-app TradingView setup guide to create alerts for Entry, Stop Loss, and Take Profit levels. Alerts can notify you and sync with the live signal dashboard.'
  },
  {
    question: 'Which payment methods are supported?',
    answer:
      'You can pay with PayPal/card, M-Pesa, Binance Pay, and SasaPay depending on availability. Subscriptions can be billed weekly or monthly.'
  },
  {
    question: 'Is trading with AI signals risk-free?',
    answer:
      'No. Forex and leveraged products involve substantial risk of loss. KachingScanner provides analytical tools and signals, not guaranteed profits. Review the Risk Disclosure before trading.'
  }
];

function faqSchema() {
  return {
    '@type': 'FAQPage',
    mainEntity: PRICING_FAQS.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer
      }
    }))
  };
}

function buildJsonLd(graph) {
  return {
    '@context': 'https://schema.org',
    '@graph': graph
  };
}

const PAGE_META = {
  home: {
    title: APP_PAGE_TITLE,
    description: APP_DESCRIPTION,
    robots: PUBLIC_ROBOTS,
    keywords: KEYWORDS,
    jsonLd: () => buildJsonLd([organizationSchema(), websiteSchema(), softwareSchema(), faqSchema()])
  },
  pricing: {
    title: `Pricing & Plans — ${APP_NAME}`,
    description:
      'Compare Basic, Pro, and Premium KachingScanner plans. Weekly or monthly billing with PayPal, M-Pesa, Binance Pay, and SasaPay. Unlock live AI forex signals and TradingView alerts.',
    robots: PUBLIC_ROBOTS,
    keywords: `${KEYWORDS}, forex subscription, trading plans`,
    jsonLd: () =>
      buildJsonLd([
        organizationSchema(),
        softwareSchema(),
        breadcrumb('pricing', 'Pricing'),
        faqSchema()
      ])
  },
  contact: {
    title: `Contact — ${APP_NAME}`,
    description:
      'Contact the KachingScanner team about AI trading plans, subscriptions, TradingView setup, or partnership inquiries. Email and phone support available.',
    robots: PUBLIC_ROBOTS,
    keywords: `${KEYWORDS}, contact, support`,
    jsonLd: () =>
      buildJsonLd([
        organizationSchema(),
        {
          '@type': 'ContactPage',
          name: `Contact ${APP_NAME}`,
          url: absoluteUrl('/contact'),
          description: `Get in touch with ${APP_NAME} for AI trading support and plan questions.`,
          mainEntity: { '@id': `${absoluteUrl('/')}#organization` }
        },
        breadcrumb('contact', 'Contact')
      ])
  },
  'risk-disclosure': {
    title: `Risk Disclosure — ${APP_NAME}`,
    description:
      'Read the KachingScanner risk disclosure. Forex and leveraged trading involve substantial risk of loss. AI signals are analytical tools, not guarantees of profit.',
    robots: PUBLIC_ROBOTS,
    keywords: `${KEYWORDS}, risk disclosure, trading risk`,
    jsonLd: () =>
      buildJsonLd([
        organizationSchema(),
        {
          '@type': 'WebPage',
          name: 'Risk Disclosure',
          url: absoluteUrl('/risk-disclosure'),
          description: 'Trading risk disclosure for KachingScanner users.'
        },
        breadcrumb('risk-disclosure', 'Risk Disclosure')
      ])
  },
  signin: {
    title: `Login — ${APP_NAME}`,
    description: `Sign in to ${APP_NAME} to access your live signal dashboard, insights, and TradingView setup.`,
    robots: PUBLIC_ROBOTS,
    keywords: `${KEYWORDS}, login, sign in`,
    jsonLd: () => buildJsonLd([organizationSchema(), breadcrumb('signin', 'Login')])
  },
  signup: {
    title: `Register — ${APP_NAME}`,
    description: `Create a ${APP_NAME} account to subscribe to AI forex signals, live charts, and TradingView alerts.`,
    robots: PUBLIC_ROBOTS,
    keywords: `${KEYWORDS}, register, sign up`,
    jsonLd: () => buildJsonLd([organizationSchema(), breadcrumb('signup', 'Register')])
  },
  referrals: {
    title: `Refer & Earn — ${APP_NAME}`,
    description:
      'Invite traders to KachingScanner and earn referral commissions on first subscriptions and renewals.',
    robots: PUBLIC_ROBOTS,
    keywords: `${KEYWORDS}, referral program, refer and earn`,
    jsonLd: () => buildJsonLd([organizationSchema(), breadcrumb('referrals', 'Refer & Earn')])
  },
  dashboard: {
    title: `Dashboard — ${APP_NAME}`,
    description: `Live AI trading signal dashboard for ${APP_NAME} subscribers.`,
    robots: PRIVATE_ROBOTS
  },
  insights: {
    title: `Insights — ${APP_NAME}`,
    description: `Trading insights, analytics, and journal tools for ${APP_NAME} subscribers.`,
    robots: PRIVATE_ROBOTS
  },
  tradingview: {
    title: `TradingView Setup — ${APP_NAME}`,
    description: `TradingView alert setup and live feed for ${APP_NAME} subscribers.`,
    robots: PRIVATE_ROBOTS
  },
  admin: {
    title: `Admin — ${APP_NAME}`,
    description: `${APP_NAME} administration console.`,
    robots: PRIVATE_ROBOTS
  },
  'verify-email': {
    title: `Verify Email — ${APP_NAME}`,
    description: `Verify your ${APP_NAME} account email address.`,
    robots: PRIVATE_ROBOTS
  },
  'reset-password': {
    title: `Reset Password — ${APP_NAME}`,
    description: `Reset your ${APP_NAME} account password.`,
    robots: PRIVATE_ROBOTS
  }
};

export function getPageMeta(page) {
  const meta = PAGE_META[page] || PAGE_META.home;
  const path = pathForPage(page);
  const url = absoluteUrl(path);
  return {
    title: meta.title,
    description: meta.description || APP_DESCRIPTION,
    keywords: meta.keywords || KEYWORDS,
    robots: meta.robots || PUBLIC_ROBOTS,
    canonical: url,
    ogType: 'website',
    ogTitle: meta.title,
    ogDescription: meta.description || APP_DESCRIPTION,
    ogUrl: url,
    ogImage: OG_IMAGE_URL,
    ogSiteName: APP_NAME,
    twitterCard: 'summary_large_image',
    twitterTitle: meta.title,
    twitterDescription: meta.description || APP_DESCRIPTION,
    twitterImage: OG_IMAGE_URL,
    jsonLd: typeof meta.jsonLd === 'function' ? meta.jsonLd() : null,
    tagline: APP_TAGLINE
  };
}
