# 学校兼容性矩阵 / School Compatibility Matrix

> **重要说明 / Disclaimer**：`lms-cli` 是独立社区项目，与下列任何学校、Instructure 或 Anthology 均无官方合作关系。列表仅反映用户或维护者在特定日期的实测情况，**不构成官方认证或全功能兼容承诺**。学校随时可能调整 SSO、MFA、设备合规策略或 API 权限。

## 兼容状态说明 / Legend

- **Preset（内置预设）**：已内置学校网址预设（可通过 `lms setup --preset <id>` 或离线搜索使用）。
- **Community Verified（社区实测）**：由获授权的本校用户在真实账号上验证过基础连接与查询。
- **Directory Searchable（目录可搜）**：Canvas 学校可通过 `lms setup --school <关键词>` 从官方目录直接搜索并确认接入，无需等待预设。

## 已知学校列表 / Known Institutions

| 学校 / Institution | 平台 / Platform | 接入方式 / Setup | 登录方式 / Auth | 实测范围 / Verified Scope | 已知限制 / Notes |
| --- | --- | --- | --- | --- | --- |
| The Hong Kong Polytechnic University (PolyU / 香港理工大学) | Canvas + Blackboard | Preset (`polyu`) | Microsoft ADFS / Entra ID SSO | 课程、通知、作业、待办、日历、文件读取/下载 | Blackboard 待办单次查询窗口有限制（已自动按 15 天分段合并）；部分课程禁用 Files 列表时使用模块/页面回退 |

## Moodle 适配器部署要求与实测范围 / Moodle Deployment Requirements

Moodle 现已作为内置只读平台适配器接入（`--moodle https://<host>`），支持以下两种凭据模式：

- **浏览器会话模式（`lms auth login --platform moodle`）**：在隔离授权窗口完成学校登录（含 SSO/MFA），采集限定在学校 HTTPS 根域名的 `MoodleSession` Cookie，经 `/my/` 内存解析 `sesskey` 后调用受审核的只读 `/lib/ajax/service.php` 接口。
- **机构允许的 Web Service 令牌模式（`lms auth token --platform moodle --stdin`）**：经标准输入私密导入学校允许的 Moodle Web Service Token，通过 POST 正文（不放入 URL 查询串）调用受审核的只读 `/webservice/rest/server.php` 函数。

**当前实测范围与已知限制（诚实声明）**：
- 自动测试套件已离线验证工具白名单、同源/HTTPS 边界、Cookie 隔离、令牌正文传递、HTTP 200 异常封包与 MCP 握手；**尚未在真实高校 Moodle 站点完成实机验收**（欢迎社区提交真实学校实测报告）。
- 要求 Moodle 部署在 HTTPS 根域名（不支持子路径如 `https://school.edu/moodle`）；站点需启用标准 Moodle Web Services 或核心只读 AJAX 接口，自定义会话 Cookie 前缀或隐藏 `M.cfg` 的主题可能需要进一步适配。

## 如何提交你的学校？ / Add Your School

已经在你的大学成功使用 `lms-cli`？花 30 秒帮助同校同学：

1. 在 [School Compatibility Roll Call Discussion](https://github.com/zs-andy/lms-cli/discussions) 留言打卡，或
2. 使用 [School / LMS Support Request 模板](https://github.com/zs-andy/lms-cli/issues/new?template=school_support.yml) 提交实测报告，或
3. 直接发起 PR 更新本文件（如希望加入内置预设，请同时附上学校官方公开的平台地址来源并修改 `src/config.ts`，见 [SCHOOLS.md](SCHOOLS.md)）。

> 请勿在报告或 PR 中包含个人学号、密码、Cookie、令牌、成绩或私人课程内容。
