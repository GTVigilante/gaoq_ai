import { Card, message } from 'antd';
import ExcelUploader from '@/components/ExcelUploader';
import { importEmployees } from '@/services/employees';
import type { Employee } from '@/types/api';

const templateColumns = [
  { title: '工号', dataIndex: 'employeeNo', key: 'employeeNo' },
  { title: '姓名', dataIndex: 'name', key: 'name' },
  { title: '部门ID', dataIndex: 'departmentId', key: 'departmentId' },
  { title: '职位', dataIndex: 'position', key: 'position' },
  { title: '身份证号', dataIndex: 'idCard', key: 'idCard' },
  { title: '手机号', dataIndex: 'phone', key: 'phone' },
  { title: '邮箱', dataIndex: 'email', key: 'email' },
  { title: '基本工资', dataIndex: 'baseSalary', key: 'baseSalary' },
];

const templateData: Partial<Employee>[] = [
  { employeeNo: 'E001', name: '张三', departmentId: 'dept-1', position: '工程师', idCard: '110101199001011234', phone: '13800138000', email: 'zhangsan@example.com', baseSalary: 8000 },
  { employeeNo: 'E002', name: '李四', departmentId: 'dept-2', position: '销售', idCard: '110101199002021234', phone: '13800138001', email: 'lisi@example.com', baseSalary: 7000 },
];

const EmployeeImport = () => {
  const handleUpload = async (data: Partial<Employee>[]) => {
    const res = await importEmployees(data);
    message.success(`成功导入 ${res.imported} 条记录`);
    if (res.errors.length > 0) {
      message.warning(`有 ${res.errors.length} 条记录失败`);
    }
  };

  return (
    <Card title="导入员工">
      <ExcelUploader<Partial<Employee>> columns={templateColumns} onUpload={handleUpload} templateData={templateData} templateFilename="employees_template.xlsx" />
    </Card>
  );
};

export default EmployeeImport;
