import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthProvider } from '@/hooks/useAuth';
import Layout from '@/components/Layout';
import PrivateRoute from '@/components/PrivateRoute';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import EmployeesList from '@/pages/Employees/List';
import EmployeeDetail from '@/pages/Employees/Detail';
import EmployeeImport from '@/pages/Employees/Import';
import DepartmentTree from '@/pages/Departments/Tree';
import PayItemList from '@/pages/PayItems/List';
import PaySchemeList from '@/pages/PaySchemes/List';
import SalaryRecordList from '@/pages/SalaryRecords/List';
import AttendanceList from '@/pages/Attendance/List';
import SIPolicyList from '@/pages/SIPolicies/List';
import TaxPolicyList from '@/pages/TaxPolicies/List';
import PayrollList from '@/pages/Payroll/List';
import PayrollDetail from '@/pages/Payroll/Detail';
import ReportOverview from '@/pages/Reports/Overview';
import AuditLogList from '@/pages/AuditLogs/List';
import Settings from '@/pages/Settings/Index';

function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<PrivateRoute><Layout /></PrivateRoute>}>
              <Route index element={<Dashboard />} />
              <Route path="employees" element={<EmployeesList />} />
              <Route path="employees/:id" element={<EmployeeDetail />} />
              <Route path="employees/import" element={<EmployeeImport />} />
              <Route path="departments" element={<DepartmentTree />} />
              <Route path="pay-items" element={<PayItemList />} />
              <Route path="pay-schemes" element={<PaySchemeList />} />
              <Route path="salary-records" element={<SalaryRecordList />} />
              <Route path="attendance" element={<AttendanceList />} />
              <Route path="si-policies" element={<SIPolicyList />} />
              <Route path="tax-policies" element={<TaxPolicyList />} />
              <Route path="payroll" element={<PayrollList />} />
              <Route path="payroll/:id" element={<PayrollDetail />} />
              <Route path="reports" element={<ReportOverview />} />
              <Route path="audit-logs" element={<AuditLogList />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ConfigProvider>
  );
}

export default App;
