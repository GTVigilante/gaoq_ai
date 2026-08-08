# Shared Contract — Stage 1 MVP

## Stack
- Backend: NestJS 11 + TypeScript + TypeORM + PostgreSQL 15 + Redis 7
- Frontend: React 19 + TypeScript + Vite + Ant Design 5 + ECharts 5
- Port: Frontend dev server on **6666**, Backend API on **3001**

## API Base
```
http://localhost:3001/api/v1
```

## Auth
- JWT Bearer token in `Authorization` header
- Login endpoint: `POST /api/v1/auth/login` → `{ token, user }`
- Default admin: admin / admin123

## Core Entities (TypeORM)
See `backend/src/entities/` for full definitions.

## API Routes Summary

### Auth
- POST /auth/login
- POST /auth/register
- GET /auth/me

### Departments
- GET /departments (tree)
- POST /departments
- PATCH /departments/:id
- DELETE /departments/:id

### Employees
- GET /employees (paginated, searchable)
- GET /employees/:id
- POST /employees
- PATCH /employees/:id
- DELETE /employees/:id
- POST /employees/import (Excel bulk import)
- GET /employees/template (download import template)

### Pay Items
- GET /pay-items
- POST /pay-items
- PATCH /pay-items/:id
- DELETE /pay-items/:id

### Pay Schemes
- GET /pay-schemes
- POST /pay-schemes
- GET /pay-schemes/:id
- PATCH /pay-schemes/:id

### Salary Records
- GET /salary-records/:employeeId
- POST /salary-records
- GET /salary-records/:employeeId/compare

### Attendance
- GET /attendance (paginated)
- POST /attendance/import (Excel)
- PATCH /attendance/:id

### SI Policies
- GET /si-policies
- POST /si-policies
- GET /si-policies/:cityCode

### Tax Policies
- GET /tax-policies
- POST /tax-policies

### Payroll Batches
- GET /payroll-batches
- POST /payroll-batches
- GET /payroll-batches/:id
- POST /payroll-batches/:id/calculate
- GET /payroll-batches/:id/progress
- POST /payroll-batches/:id/confirm
- POST /payroll-batches/:id/rollback
- DELETE /payroll-batches/:id

### Payroll Details
- GET /payroll-details?batchId=&employeeId=
- GET /payroll-details/:id
- PATCH /payroll-details/:id
- GET /payroll-details/:id/compare

### Reports
- GET /reports/cost-overview?period=
- GET /reports/department-analysis?period=

### Audit Logs
- GET /audit-logs

## Frontend Routes
- /login — Login page
- /dashboard — Dashboard overview
- /employees — Employee list & management
- /employees/:id — Employee detail
- /departments — Department tree
- /pay-schemes — Pay scheme config
- /pay-items — Pay item config (with formula editor)
- /salary-records — Salary record management
- /attendance — Attendance import & management
- /si-policies — Social insurance policy management
- /tax-policies — Tax policy management
- /payroll — Payroll batches & calculation
- /payroll/:id — Batch detail & employee payslips
- /reports — Reports & analytics
- /audit-logs — Audit logs
- /settings — System settings

## Data Flow
1. Admin configures pay items + pay schemes
2. HR imports employees (Excel) + attendance (Excel)
3. Admin configures SI policies + tax policies for city
4. HR creates payroll batch → calculates → reviews → confirms
5. System generates payroll details + reports
6. All actions are audited
