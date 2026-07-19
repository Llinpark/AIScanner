const TABS = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'signals', label: 'Signals' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'payments', label: 'Payments' },
  { id: 'referrals', label: 'Referrals' },
  { id: 'audit', label: 'Audit' }
];

export default function AdminLayout({ activeTab, onTabChange, children }) {
  return (
    <div className="admin-shell">
      <header className="admin-hero">
        <div className="admin-hero-copy">
          <span className="admin-badge">Admin</span>
          <p className="admin-eyebrow">Internal operations</p>
          <h1 className="admin-title">Admin Console</h1>
          <p className="admin-subtitle">Monitor users, signals, and scanner configuration in one place.</p>
        </div>
      </header>

      <div className="admin-tabs-scroll">
        <nav className="admin-tabs" aria-label="Admin sections">
          {TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`admin-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => onTabChange(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="admin-content">{children}</div>
    </div>
  );
}
