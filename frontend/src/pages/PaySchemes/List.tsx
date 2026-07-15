import { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Form, Input, Select, message, Popconfirm, Space, List, Switch } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { listPaySchemes, createPayScheme, updatePayScheme, deletePayScheme } from '@/services/paySchemes';
import { listPayItems } from '@/services/payItems';
import type { PayScheme, PayItem } from '@/types/api';

const PaySchemeList = () => {
  const [data, setData] = useState<PayScheme[]>([]);
  const [payItems, setPayItems] = useState<PayItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<PayScheme | null>(null);
  const [form] = Form.useForm();
  const [itemsForm] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const [schemes, items] = await Promise.all([
        listPaySchemes({ pageSize: 100 }),
        listPayItems({ pageSize: 100 }),
      ]);
      setData(schemes.items);
      setPayItems(items.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const schemeItems = itemsForm.getFieldsValue().items || [];
      const payload = { ...values, items: schemeItems };
      if (editing) {
        await updatePayScheme(editing.id, payload);
        message.success('更新成功');
      } else {
        await createPayScheme(payload);
        message.success('创建成功');
      }
      setModalVisible(false);
      fetchData();
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePayScheme(id);
      message.success('删除成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: '默认', dataIndex: 'isDefault', key: 'isDefault', render: (v: boolean) => <Switch checked={v} disabled /> },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: PayScheme) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => { setEditing(record); form.setFieldsValue(record); itemsForm.setFieldsValue({ items: record.items || [] }); setModalVisible(true); }}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card title="薪酬方案" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); itemsForm.resetFields(); setModalVisible(true); }}>新增</Button>}>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading} pagination={false} />
      <Modal title={editing ? '编辑薪酬方案' : '新增薪酬方案'} open={modalVisible} onOk={handleSubmit} onCancel={() => setModalVisible(false)} destroyOnClose width={700}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea /></Form.Item>
          <Form.Item name="isDefault" label="默认方案" valuePropName="checked"><Switch /></Form.Item>
        </Form>
        <Form form={itemsForm}>
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <div>
                <Button type="dashed" onClick={() => add()} block>添加项目</Button>
                <List
                  dataSource={fields}
                  renderItem={(field) => (
                    <List.Item style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Form.Item name={[field.name, 'payItemId']} rules={[{ required: true }]} noStyle>
                        <Select placeholder="选择薪酬项目" style={{ width: 200 }}>
                          {payItems.map((item) => <Select.Option key={item.id} value={item.id}>{item.name}</Select.Option>)}
                        </Select>
                      </Form.Item>
                      <Form.Item name={[field.name, 'formula']} noStyle>
                        <Input placeholder="自定义公式(可选)" style={{ width: 200 }} />
                      </Form.Item>
                      <Button danger onClick={() => remove(field.name)}>删除</Button>
                    </List.Item>
                  )}
                />
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>
    </Card>
  );
};

export default PaySchemeList;
