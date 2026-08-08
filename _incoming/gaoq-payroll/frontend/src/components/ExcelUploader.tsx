import { useState } from 'react';
import { Upload, Button, Table, message, Space } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';

interface ExcelUploaderProps<T> {
  columns: { title: string; dataIndex: string; key: string }[];
  onUpload: (data: T[]) => Promise<void>;
  templateData?: T[];
  templateFilename?: string;
}

const ExcelUploader = <T extends Record<string, unknown>>({
  columns,
  onUpload,
  templateData,
  templateFilename = 'template.xlsx',
}: ExcelUploaderProps<T>) => {
  const [previewData, setPreviewData] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet) as T[];
        setPreviewData(jsonData.slice(0, 10));
      } catch (err) {
        message.error('解析 Excel 失败');
      }
    };
    reader.readAsArrayBuffer(file);
    return false;
  };

  const handleUpload = async () => {
    if (previewData.length === 0) {
      message.warning('请先选择文件');
      return;
    }
    setLoading(true);
    try {
      await onUpload(previewData);
      setPreviewData([]);
    } finally {
      setLoading(false);
    }
  };

  const downloadTemplate = () => {
    if (!templateData) return;
    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, templateFilename);
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Upload beforeUpload={handleFile} showUploadList={false} accept=".xlsx,.xls">
          <Button icon={<UploadOutlined />}>选择 Excel 文件</Button>
        </Upload>
        {templateData && <Button onClick={downloadTemplate}>下载模板</Button>}
        <Button type="primary" onClick={handleUpload} loading={loading} disabled={previewData.length === 0}>
          确认导入
        </Button>
      </Space>
      {previewData.length > 0 && (
        <div>
          <p>预览前 10 条数据：</p>
          <Table columns={columns} dataSource={previewData.map((item, idx) => ({ ...item, key: idx }))} pagination={false} size="small" />
        </div>
      )}
    </div>
  );
};

export default ExcelUploader;
