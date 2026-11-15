# lms-cli

面向 Canvas 和 Blackboard 的多学校命令行工具，为终端和 Agent 提供统一的课程、通知、作业、成绩反馈与资料查询接口。

安装、学校搜索、配置和更新均在终端完成。只有学校登录或 MFA 需要交互时才打开授权窗口。支持独立使用 CLI，也可通过 MCP 接入 Codex、Claude Code 或其他 Agent 客户端。

## 快速开始

### 1. 安装

macOS / Linux：

```sh
curl -fsSL --proto '=https' https://raw.githubusercontent.com/zs-andy/lms-cli/main/install.sh | sh
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/zs-andy/lms-cli/main/install.ps1).Content))
```

安装器从 [GitHub Releases](https://github.com/zs-andy/lms-cli/releases) 获取匹配系统和 CPU 架构的稳定版 CLI，校验 SHA-256 后安装到用户目录，无需管理员权限。自包含安装包内置 Node.js 和授权运行时，无需预装 Node.js、npm 或 Git。执行远程脚本前，请审阅并确认来源。

在线安装需要 Release 中包含对应的 `lms-cli-<version>-<os>-<arch>.tar.gz` 和 `SHA256SUMS.txt`。目标平台的安装包尚未发布时，可采用[源码安装](docs/DEVELOPMENT.md#源码安装)。Linux 需要系统密钥服务；网页登录需要图形会话。

### 2. 搜索并连接学校

```sh
lms setup
```

首次配置时，输入学校名称或域名，按编号选择搜索结果，核对平台网址和学校时区。随后完成 Codex 接入、必要的学校授权，以及身份和课程列表检查。已有默认账号时，重复运行会继续该账号的配置流程。

```sh
lms setup --school "Hong Kong"   # 搜索并添加学校
lms setup --manual              # 直接输入平台网址
lms setup --no-codex            # 独立使用 CLI
lms setup --no-login            # 只做本地配置，暂不登录
```

Canvas 搜索使用官方学校目录；Blackboard 当前提供本地预设和手动网址接入。搜索不到时，可使用学校公布的 HTTPS 平台根地址。详见[学校搜索与多账号配置](docs/SCHOOLS.md)。

### 3. 查询

```sh
lms canvas courses
lms blackboard courses
lms overview --days 7 --fresh
```

运行已配置平台的命令即可。接入 Codex 后，在新任务中输入：

> 整理本周课程和作业安排，同时检查老师通知中的调课和截止时间变更，附上来源。

### 在 Claude Code 中使用

先完成上面的安装，并用 `lms setup --no-codex` 配置学校（`lms connect codex` 只用于 Codex）。然后在 Claude Code 中安装本仓库的插件：

```sh
claude plugin marketplace add zs-andy/lms-cli
claude plugin install lms-cli@lms-cli
```

插件只注册 `lms mcp` 服务和 `lms-query` 技能，不会安装 CLI，需要 `lms` 已在 PATH 中。安装后新开一个会话即可提问。不想使用插件时，也可以直接运行 `claude mcp add --scope user lms -- lms mcp`；两种方式不要同时启用。

只读的 `lms` 工具带有 MCP 只读标注，可按需在 Claude Code 的权限设置中放行；`lms_profile_add`、`lms_profile_use`、`lms_auth_login` 和 `lms_items_upsert` 会修改本地配置或打开登录窗口，建议保持逐次确认。Codex 插件位于 `plugins/lms-cli/`，Claude Code 插件位于 `plugins/lms-cli-claude/`，两者互相独立。

## 实验性登录选项

需要重新授权时，仍然打开各学校自己的登录页面及其 SSO 跳转，不会替换成统一的账号密码页。窗口顶部提供默认关闭的“记住密码”和“自动登录”：前者在下次填充账号密码后由你点击学校的登录按钮；后者同时启用记住密码，填充后等待 2 秒再自动提交。有效会话直接复用。

两项均为**实验性功能**，支持常见标准表单、分步账号／密码页面、精确匹配的 HTTPS 跨域提交地址，以及 PolyU 等使用的 Microsoft ADFS 脚本式按钮；不保证所有学校兼容。密码仅在成功验证学校身份后在本机加密保存。开启记住密码也会保留按学校/账号、平台隔离的本应用登录分区，以保留学校允许的受信设备状态。

取消勾选自动登录会停止后续自动操作；点击“取消”、按 Esc 或关闭窗口可结束本次登录及其 SSO 弹窗，不能撤回已发送的请求。可选 TOTP 密钥仅通过私密 stdin 导入；CAPTCHA、推送确认和设备合规检查仍由学校控制。详细用法及清理方式见[用户指南](docs/USER_GUIDE.md#实验性记住密码与自动登录)。

Blackboard 待办查询按最多 15 天的窗口请求真实待办接口并去重合并，解决 PolyU 单次范围超过上限时的报错。接口、权限或网络失败仍返回错误，不会用日历事件替代待办。

### 后台自动重新授权

已在授权窗口启用“记住密码”和“自动登录”后，可在定时任务或 MCP 服务环境中设置 `LMS_AUTH_BACKGROUND=1`：

```sh
LMS_AUTH_BACKGROUND=1 lms overview --days 7 --fresh
LMS_AUTH_BACKGROUND=1 lms auth login
```

此模式隐藏授权主窗口、学校 SSO 子窗口及 JavaScript 对话框，不抢焦点；macOS 也不显示 Dock 图标。每个平台最多尝试 45 秒，其中一个失败仍会尝试其余平台。没有已保存的自动登录授权时直接失败，不自动保存密码或改变授权选项。MFA、CAPTCHA、网络错误及不支持的表单不会自动弹出窗口；未完成的授权沿用 `cancelled` 状态，调用方应报告缺失来源，不能声称登录成功。手动修复时，在未设置该环境变量的终端运行 `lms auth login`。默认交互式登录流程不变。

## 更新

```sh
lms update --check      # 检查版本
lms update              # 检查并确认升级
lms update --rollback   # 确认后回退到上一版本
```

交互式 CLI 使用时会检查稳定版；MCP 会话首次读取配置时也会返回更新信息。更新需要用户确认，并保留学校配置、凭据和本地待办。自动升级适用于自包含安装；源码安装按[开发指南](docs/DEVELOPMENT.md)重新构建。使用 `LMS_UPDATE_CHECK=0` 可关闭自动检查。

## 一键安装提示词

将以下提示词交给具有终端操作能力的 Agent：

> 安装 https://github.com/zs-andy/lms-cli 的最新稳定版。检查系统、CPU 架构与现有安装，使用该仓库的匹配 Release 安装包并验证 SHA-256。运行 lms setup，在终端搜索我的学校，让我确认学校网址和时区，再完成配置和客户端接入。仅在学校登录或 MFA 必要时打开授权窗口，不索取或记录密码、验证码、Cookie。保留已有账号、凭据、待办和其他插件；替换同名插件前征得确认。最后检查连接和可用更新，报告结果。缺少安装包、权限或必要运行环境时，说明具体原因和处理方式。

## 功能与数据边界

- 查询课程、通知、作业、成绩反馈、文件和日历；根据通知识别安排变更并保留来源。
- 按学校/账号隔离凭据、查询缓存和本地待办；支持同时配置 Canvas 与 Blackboard。
- 按用户要求保存本地待办、保留时间变更历史，并导出 ICS 日历。
- 提供结构化 CLI 输出、只读 MCP 工具、学校搜索、连接诊断和更新管理。

学校平台访问仅限当前账号的权限，不提交作业、开始考试、发送消息或修改平台内容。登录有效性、API 权限与平台版本会影响可用功能；Blackboard 连接器依赖 Learn Ultra 内部接口。搜索结果是网址线索，实际连接状态以检查结果为准。

会话和本地待办加密保存在本机，密钥由系统凭据库管理。Agent 查询所需的内容会交给所选客户端处理；下载文件和导出的日历为普通文件。详见[隐私说明](PRIVACY.md)与[安全说明](SECURITY.md)。

## 文档

用户：

- [用户指南](docs/USER_GUIDE.md)：安装、授权、查询、更新、故障排查。
- [学校与账号](docs/SCHOOLS.md)：联网搜索、手动接入、多学校与多账号。
- [安装选项](docs/CLI_INSTALL.md)：安装目录、离线安装及运行时布局。

开发者：

- [开发指南](docs/DEVELOPMENT.md)：源码构建、测试、MCP 与学校目录扩展。
- [架构说明](docs/ARCHITECTURE.md)与[平台接入指南](docs/ADDING_A_PLATFORM.md)。
- [贡献指南](CONTRIBUTING.md)、[验收清单](docs/ACCEPTANCE.md)、[验证记录](docs/VALIDATION.md)和[发布流程](docs/RELEASING.md)。

## 开源与许可

本项目为独立社区项目，与学校、Instructure、Anthology 或 OpenAI 无隶属或官方合作关系。学校预设仅用于配置便利，不代表学校认可。

连接器复用 [canvas-student-mcp](https://github.com/xmike04/canvas-student-mcp) 与 [blackboard-mcp](https://github.com/felipedias-ie/blackboard-mcp)，并使用 Electron、Model Context Protocol SDK 等开源组件。版本、许可证和本地修改见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目代码与原创图标采用 [MIT License](LICENSE)；第三方名称与标识归各自权利人所有。
