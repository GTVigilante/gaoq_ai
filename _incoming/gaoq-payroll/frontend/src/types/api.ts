export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Employee {
  id: string;
  employeeNo: string;
  name: string;
  departmentId: string;
  departmentName?: string;
  position: string;
  idCard: string;
  phone: string;
  email: string;
  bankAccount: string;
  bankName: string;
  hireDate: string;
  status: 'active' | 'inactive' | 'terminated';
  baseSalary: number;
  createdAt: string;
  updatedAt: string;
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  code: string;
  managerId?: string;
  employeeCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PayItem {
  id: string;
  code: string;
  name: string;
  category: 'basic' | 'allowance' | 'bonus' | 'deduction' | 'social' | 'tax';
  type: 'fixed' | 'formula' | 'manual';
  formula?: string;
  defaultValue?: number;
  isTaxable: boolean;
  isVisible: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface PayScheme {
  id: string;
  name: string;
  description: string;
  items: PaySchemeItem[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaySchemeItem {
  id: string;
  payItemId: string;
  payItemName?: string;
  formula?: string;
  isEnabled: boolean;
  sortOrder: number;
}

export interface SalaryRecord {
  id: string;
  employeeId: string;
  employeeName?: string;
  year: number;
  month: number;
  items: SalaryRecordItem[];
  grossAmount: number;
  deductionAmount: number;
  netAmount: number;
  status: 'draft' | 'confirmed' | 'paid';
  createdAt: string;
  updatedAt: string;
}

export interface SalaryRecordItem {
  id: string;
  payItemId: string;
  payItemName?: string;
  amount: number;
  formula?: string;
  remark?: string;
}

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeName?: string;
  year: number;
  month: number;
  workDays: number;
  actualWorkDays: number;
  leaveDays: number;
  sickLeaveDays: number;
  personalLeaveDays: number;
  absentDays: number;
  overtimeHours: number;
  status: 'draft' | 'confirmed' | 'adjusted';
  createdAt: string;
  updatedAt: string;
}

export interface SIPolicy {
  id: string;
  city: string;
  pensionEmployeeRate: number;
  pensionEmployerRate: number;
  medicalEmployeeRate: number;
  medicalEmployerRate: number;
  unemploymentEmployeeRate: number;
  unemploymentEmployerRate: number;
  injuryEmployerRate: number;
  maternityEmployerRate: number;
  housingFundEmployeeRate: number;
  housingFundEmployerRate: number;
  pensionBaseMin: number;
  pensionBaseMax: number;
  medicalBaseMin: number;
  medicalBaseMax: number;
  housingFundBaseMin: number;
  housingFundBaseMax: number;
  effectiveDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaxPolicy {
  id: string;
  name: string;
  level: number;
  minAmount: number;
  maxAmount: number;
  rate: number;
  quickDeduction: number;
  effectiveDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollBatch {
  id: string;
  name: string;
  year: number;
  month: number;
  status: 'draft' | 'calculated' | 'confirmed' | 'paid';
  totalEmployees: number;
  totalGross: number;
  totalDeduction: number;
  totalNet: number;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollPayslip {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  departmentName: string;
  grossAmount: number;
  deductionAmount: number;
  taxAmount: number;
  netAmount: number;
  items: PayrollPayslipItem[];
}

export interface PayrollPayslipItem {
  payItemId: string;
  payItemName: string;
  amount: number;
  category: string;
}

export interface AuditLog {
  id: string;
  userId: string;
  username?: string;
  action: string;
  module: string;
  detail: string;
  ipAddress: string;
  createdAt: string;
}

export interface ReportCostOverview {
  totalSalary: number;
  totalBonus: number;
  totalSocial: number;
  totalTax: number;
  departmentCosts: { name: string; cost: number }[];
  monthlyTrends: { month: string; cost: number }[];
}

export interface User {
  id: string;
  username: string;
  name: string;
  role: string;
  email: string;
  createdAt: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}
