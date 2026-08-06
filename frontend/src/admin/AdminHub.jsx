import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import AdminLayout from './AdminLayout';
import AdminDashboard from './AdminDashboard';
import AdminUsers from './AdminUsers';
import AdminScanner from './AdminScanner';
import AdminSignals from './AdminSignals';
import AdminPipeline from './AdminPipeline';
import AdminPayments from './AdminPayments';
import AdminActivations from './AdminActivations';
import AdminReferrals from './AdminReferrals';
import AdminAuditLog from './AdminAuditLog';

export default function AdminHub({ initialTab = 'dashboard' }) {
  const { user } = useAuth();
  const canManageScanner = Boolean(user?.isSuperAdmin || user?.canManageScannerConfig);
  const superAdminTabs = new Set(['pipeline', 'scanner', 'activations']);
  const resolvedInitial =
    superAdminTabs.has(initialTab) && !canManageScanner ? 'dashboard' : initialTab;
  const [activeTab, setActiveTab] = useState(resolvedInitial);

  useEffect(() => {
    if (superAdminTabs.has(activeTab) && !canManageScanner) {
      setActiveTab('dashboard');
    }
  }, [activeTab, canManageScanner]);

  return (
    <AdminLayout activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'dashboard' && <AdminDashboard />}
      {activeTab === 'pipeline' && canManageScanner && <AdminPipeline />}
      {activeTab === 'users' && <AdminUsers />}
      {activeTab === 'signals' && <AdminSignals />}
      {activeTab === 'scanner' && canManageScanner && <AdminScanner />}
      {activeTab === 'activations' && canManageScanner && <AdminActivations />}
      {activeTab === 'payments' && <AdminPayments />}
      {activeTab === 'referrals' && <AdminReferrals />}
      {activeTab === 'audit' && <AdminAuditLog />}
    </AdminLayout>
  );
}
