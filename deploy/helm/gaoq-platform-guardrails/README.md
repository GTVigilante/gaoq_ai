# GaoQ Kubernetes 平台护栏

本 Chart 为受保护生产部署提供云中立的集群侧最小权限基线：双命名空间、Pod Security Restricted、ResourceQuota、LimitRange、OIDC Group RBAC 和 ValidatingAdmissionPolicy。它不包含云账号、集群凭据、Secret、证书或业务工作负载。

平台管理员必须先在隔离集群渲染、schema 校验并执行准入正反例，再在独立审批窗口安装。应用 CD 没有安装或修改本 Chart 的权限。

本 Chart 的 Helm release 必须存放在预先存在、仅平台管理员可访问的平台管理命名空间，且该命名空间必须与 Chart 创建的控制/业务命名空间不同。这样首次安装不依赖尚未创建的控制命名空间，应用 Runner 也无法读取或修改护栏 release 元数据。

核心边界：

- Plan Group 只读控制命名空间中的 Helm release ConfigMap，并只读业务命名空间中两个指定的运行时 ConfigMap；它不能写 Deployment，也不能读取 Secret。
- Apply Group 只在控制命名空间管理当前 Helm release ConfigMap，只在独立业务命名空间管理 GaoQ-OS 白名单资源；它不能读取 Secret、修改 RBAC 或操作集群级资源。
- 两条 ValidatingAdmissionPolicy 要求写请求必须来自 apply OIDC Group，并进一步绑定 release 标签、经审批的应用资源名称前缀和 Helm release ConfigMap 标签；RBAC 或工作流误配时仍失败关闭。
- Namespace、RBAC 与准入策略属于集群管理员 R3 操作，永久不提供 MCP Tool。
