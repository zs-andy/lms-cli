# PolyU LMS CLI

在 Codex 中用自然语言查询香港理工大学的 Canvas 和 Blackboard，也可以通过命令行或其他 MCP 客户端使用。

除了平台上的作业和日历，本项目还会读取老师的通知，帮助你识别通知中的作业、考试和调课。它是通用的学习平台查询工具，不限于生成时间表。

这是社区项目，与香港理工大学、Instructure、Anthology 或 OpenAI 没有隶属或官方合作关系。当前仅面向 PolyU，不承诺适用于其他学校。

## 功能

- 查询课程、通知、作业、考试安排、成绩反馈和课程资料。
- 结合老师通知整理时间表，保留来源链接，标出不确定的时间和适用班级。
- 按需保存本地待办，保留截止时间变更历史，并导出 ICS 日历文件。
- 在 Codex 中自动检查授权；需要登录时打开独立登录窗口，无需复制 Cookie。
- 提供只读 CLI 和 MCP 接口，复用已有的开源 Canvas、Blackboard 连接器。

本项目不会提交作业、开始考试、发送消息或修改学校平台中的内容。安装也不会自动开启每日扫描或订阅第三方日历。

## 当前状态

当前版本为 **0.2.0 预览版**。

- macOS Apple Silicon：已通过本地构建、自动测试及授权窗口检查。
- Windows 和 Linux：提供跨平台代码和 CI 构建，尚未完成真实校园账号的人工验收。
- 完整登录、MFA 和实际课程问答仍需要使用者按学校政策验收。
- 安装包尚未签名或公证；请仅从本仓库下载并核对发布说明。
- 尚未发布到公共 npm，也不代表已获 Codex 官方精选市场收录。

详见 [验证记录](docs/VALIDATION.md) 和 [验收清单](docs/ACCEPTANCE.md)。

## 安装

### 1. 准备环境

需要：

- Node.js 22.16 或更新版本，推荐 Node.js 24 LTS。
- 支持插件的 Codex，以及可在终端运行的 `codex` 命令。
- 可以正常访问两平台的 PolyU 账号。

Linux 还需要可用的桌面密钥服务。只有服务器终端、没有桌面登录环境的场景暂不作为推荐使用方式。

### 2. 安装 CLI

从 [Releases](https://github.com/zs-andy/polyu-lms-cli/releases) 下载 `canvas-blackboard-cli-0.2.0.tgz`，在下载目录运行：

```sh
npm install -g ./canvas-blackboard-cli-0.2.0.tgz
lms init --preset polyu
lms doctor
```

请不要省略 optional dependencies：默认安装会带上登录窗口所需的 Electron。macOS 用户也可从同一 Release 安装独立授权 App，但它不能替代 CLI。

### 3. 安装 Codex 插件

```sh
codex plugin marketplace add zs-andy/polyu-lms-cli --ref v0.2.0
codex plugin add lms-cli@polyu-lms
```

这是本项目的 GitHub 插件市场，不是 Codex 官方精选市场。安装完成后，新建一个 Codex 任务，选择「PolyU 学习助手」。

如果之前使用的是本地开发版 `lms-cli@personal`，请先移除旧版本，避免重复工具：

```sh
codex plugin remove lms-cli@personal
```

### 4. 直接提问

例如：

> 整理本周安排，考虑老师通知里的作业和调课，附上来源。

> 两个平台最近有哪些重要通知？

> 找到这门课的实验说明，告诉我提交要求和评分方式。

首次查询需要授权时，会打开登录窗口。请在窗口中自行完成 PolyU 登录和 MFA，不要在聊天中发送密码或验证码。登录完成后，Codex 会继续查询。

也可以提前在终端登录：

```sh
lms auth login
lms auth status --live
```

## 命令行使用

```sh
# 查看两平台的课程
lms canvas courses
lms blackboard courses

# 查看最近安排和通知
lms overview --days 7 --fresh

# 查找可用的查询能力
lms tools --query feedback
lms tools --name bb_get_grade_detail

# 独立终端中的自然语言问答
lms ask "老师最近调整了哪些作业或上课安排？请附来源。"

# 查看已保存的待办并导出日历
lms items list
lms items export --out semester.ics
```

`lms ask` 需要已登录、支持 `exec --ignore-user-config` 的 Codex CLI；在 Codex App 中使用插件时不需要运行它。结构化查询默认输出 JSON，自然语言命令输出回答。模型服务的费用和额度由你的 Codex 账号决定。

导出日历只包含已保存、时间明确的事项，不会自动扫描或订阅第三方日历。新增或更新本地待办需要明确提出保存要求。更多参数见 `lms --help`，输入示例见 [items.example.json](docs/items.example.json)。

## 其他 MCP 客户端

运行：

```sh
lms mcp-config
```

将输出配置加入客户端。此命令不会替你修改客户端设置，输出中的绝对路径只适用于当前电脑，不要提交到仓库。

Windows 客户端如果无法直接启动 npm 的 `.cmd` 命令，也可以使用此配置中的 Node 可执行文件和脚本路径。

## 隐私与权限

- 只读取当前账号有权访问的课程内容，不绕过学校登录、MFA 或访问限制。
- 会话凭据和本地待办加密保存，密钥交给操作系统凭据库管理。
- 学校密码和验证码不会保存到项目中，也不会作为工具结果发送给模型。
- 查询所需的课程、通知或资料内容会进入你正在使用的 AI 客户端，其数据政策同样适用。
- 下载的课程文件和导出的 ICS 是普通文件，需要自行保管；退出登录不会删除它们。
- 本项目没有托管数据后端，不提供永久免登录或后台自动续期保证。

完整说明见 [隐私说明](PRIVACY.md) 和 [安全说明](SECURITY.md)。请勿在 Issue 中上传 Cookie、密码、验证码、真实成绩或私人课程资料。

## 已知限制

- 快速概览有通知时间范围和分页上限，不等于读取了所有历史内容及附件。
- 模糊日期、学期周次和分组安排需要进一步确认，AI 回答不能替代老师的正式通知。
- Blackboard 使用的部分接口可能随平台升级变化。
- 学校若限制内嵌登录，应遵守学校政策，本项目不会绕过该限制。
- 独立 `lms ask` 不加载自定义 Codex 配置，自建模型网关等特殊设置尚未完整覆盖。

## 常见问题

**Codex 找不到 `lms`**

先确认终端中的 `lms doctor` 正常，再重启 Codex。如果桌面应用没有继承终端 PATH，使用 `lms mcp-config` 输出的配置在本机连接 MCP；不要修改或提交共享仓库中的个人路径。

**登录过了，为什么还要求登录？**

校园会话会过期。重新完成登录即可。`lms auth status` 只检查已保存的状态；`lms auth status --live` 才会向平台验证。

**如何退出登录？**

```sh
lms auth logout --platform canvas --yes
lms auth logout --platform blackboard --yes
```

这会删除本地保存的相应会话，但不等于撤销学校服务器上的会话，也不会删除已有待办、下载文件或日历。

**其他学校可以用吗？**

当前不能保证。公开界面只提供 PolyU 配置；其他学校需要单独验证后再加入支持。

## 开发与贡献

```sh
git clone https://github.com/zs-andy/polyu-lms-cli.git
cd polyu-lms-cli
npm ci
npm run typecheck
npm test
npm run pack:cli
npm run pack:app
```

主要目录：

- `src/`：CLI、MCP、数据处理与授权 App。
- `vendor/`：固定版本的上游连接器及许可证。
- `plugins/lms-cli/`：Codex 插件。
- `.agents/plugins/marketplace.json`：GitHub 插件市场入口。
- `test/`：离线自动测试。
- `docs/`：验收、验证和发布说明。

提交前请阅读 [贡献指南](CONTRIBUTING.md)。发布流程见 [RELEASING.md](docs/RELEASING.md)。

## 开源组件与许可

复用以下社区项目：

- [canvas-student-mcp](https://github.com/xmike04/canvas-student-mcp)
- [blackboard-mcp](https://github.com/felipedias-ie/blackboard-mcp)
- Electron、Model Context Protocol TypeScript SDK 及系统凭据库等开源组件。

具体版本、许可证和本地修改见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

项目代码采用 [MIT License](LICENSE)。PolyU 校名和校徽、Canvas、Blackboard、Codex 等名称或标识属于各自权利人，不包含在本项目的 MIT 授权范围内。展示校徽不代表学校认可或授权本项目。
