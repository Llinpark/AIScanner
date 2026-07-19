import { useState } from 'react';
import AdminLayout from './AdminLayout';
import AdminDashboard from './AdminDashboard';
import AdminUsers from './AdminUsers';
import AdminScanner from './AdminScanner';
import AdminSignals from './AdminSignals';
import AdminPayments from './AdminPayments';
import AdminReferrals from './AdminReferrals';
import AdminAuditLog from './AdminAuditLog';

export default function AdminHub({ initialTab = 'dashboard' }) {
  const [activeTab, setActiveTab] = useState(initialTab);

  return (
    <AdminLayout activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'dashboard' && <AdminDashboard />}
      {activeTab === 'users' && <AdminUsers />}
      {activeTab === 'signals' && <AdminSignals />}
      {activeTab === 'scanner' && <AdminScanner />}
      {activeTab === 'payments' && <AdminPayments />}
      {activeTab === 'referrals' && <AdminReferrals />}
      {activeTab === 'audit' && <AdminAuditLog />}
    </AdminLayout>
  );
}
