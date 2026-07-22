import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import AdminLayout from './AdminLayout';
import AdminDashboard from './AdminDashboard';
import AdminUsers from './AdminUsers';
import AdminScanner from './AdminScanner';
import AdminSignals from './AdminSignals';
import AdminPayments from './AdminPayments';
import AdminReferrals from './AdminReferrals';
import AdminAuditLog from './AdminAuditLog';

export default function AdminHub({ initialTab = 'dashboard' }) {
  const { user } = useAuth();
  const canManageScanner = Boolean(user?.isSuperAdmin || user?.canManageScannerConfig);
  const resolvedInitial =
    initialTab === 'scanner' && !canManageScanner ? 'dashboard' : initialTab;
  const [activeTab, setActiveTab] = useState(resolvedInitial);

  useEffect(() => {
    if (activeTab === 'scanner' && !canManageScanner) {
      setActiveTab('dashboard');
    }
  }, [activeTab, canManageScanner]);

  return (
    <AdminLayout activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'dashboard' && <AdminDashboard />}
      {activeTab === 'users' && <AdminUsers />}
      {activeTab === 'signals' && <AdminSignals />}
      {activeTab === 'scanner' && canManageScanner && <AdminScanner />}
      {activeTab === 'payments' && <AdminPayments />}
      {activeTab === 'referrals' && <AdminReferrals />}
      {activeTab === 'audit' && <AdminAuditLog />}
    </AdminLayout>
  );
}
