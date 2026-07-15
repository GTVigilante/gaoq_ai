import { useEffect, useState } from 'react';
import { Card, Tree, Button, Modal, Form, Input, message, Popconfirm, Tag, Spin } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { listDepartments, createDepartment, updateDepartment, deleteDepartment } from '@/services/departments';
import type { Department } from '@/types/api';

const DepartmentTree = () => {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await listDepartments();
      setDepartments(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAdd = (parentId?: string) => {
    setEditing(null);
    form.resetFields();
    if (parentId) form.setFieldsValue({ parentId });
    setModalVisible(true);
  };

  const handleEdit = (record: Department) => {
    setEditing(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        await updateDepartment(editing.id, values);
        message.success('更新成功');
      } else {
        await createDepartment(values);
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
      await deleteDepartment(id);
      message.success('删除成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const buildTree = (items: Department[], parentId: string | null = null): any[] => {
    return items
      .filter((item) => item.parentId === parentId)
      .map((item) => ({
        title: (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{item.name} <Tag>{item.employeeCount || 0}人</Tag></span>
            <span>
              <Button type="link" size="small" icon={<PlusOutlined />} onClick={(e) => { e.stopPropagation(); handleAdd(item.id); }}>添加子部门</Button>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); handleEdit(item); }}>编辑</Button>
              <Popconfirm title="确认删除？" onConfirm={(e) => { e?.stopPropagation(); handleDelete(item.id); }}>
                <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()}>删除</Button>
              </Popconfirm>
            </span>
          </div>
        ),
        key: item.id,
        children: buildTree(items, item.id),
      }));
  };

  const treeData = buildTree(departments);

  return (
    <Card title="部门管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => handleAdd()}>新增部门</Button>}>
      <Spin spinning={loading}>
        <Tree treeData={treeData} defaultExpandAll />
      </Spin>
      <Modal title={editing ? '编辑部门' : '新增部门'} open={modalVisible} onOk={handleSubmit} onCancel={() => setModalVisible(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="部门名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="code" label="部门编码" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="parentId" label="上级部门"><Input placeholder="留空为根部门" /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default DepartmentTree;
