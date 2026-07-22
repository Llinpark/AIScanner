import { useAuth } from '../context/AuthContext';

const ALL_TABS = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'signals', label: 'Signals' },
  { id: 'scanner', label: 'Scanner', superAdminOnly: true },
  { id: 'payments', label: 'Payments' },
  { id: 'referrals', label: 'Referrals' },
  { id: 'audit', label: 'Audit' }
];

export default function AdminLayout({ activeTab, onTabChange, children }) {
  const { user } = useAuth();
  const canManageScanner = Boolean(user?.isSuperAdmin || user?.canManageScannerConfig);
  const tabs = ALL_TABS.filter(tab => !tab.superAdminOnly || canManageScanner);

  return (
    <div className="admin-shell">
      <header className="admin-hero">
        <div className="admin-hero-copy">
          <span className="admin-badge">{canManageScanner ? 'Super Admin' : 'Admin'}</span>
          <p className="admin-eyebrow">Internal operations</p>
          <h1 className="admin-title">Admin Console</h1>
          <p className="admin-subtitle">
            {canManageScanner
              ? 'Monitor users, signals, and scanner configuration in one place.'
              : 'Monitor users, signals, payments, and referrals.'}
          </p>
        </div>
      </header>

      <div className="admin-tabs-scroll">
        <nav className="admin-tabs" aria-label="Admin sections">
          {tabs.map(tab => (
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
