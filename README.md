# lms-cli

支持多学校的 Canvas / Blackboard 学习助手。在 Codex 中用自然语言查询课程、通知、作业和反馈，也可以通过命令行或其他 MCP 客户端使用。

除了平台上的作业和日历，本项目还会读取老师的通知，帮助你识别通知中的作业、考试和调课。它是通用的学习平台查询工具，不限于生成时间表。

这是社区项目，与任何学校、Instructure、Anthology 或 OpenAI 没有隶属或官方合作关系。支持自定义学校网址和多个学校/账号；PolyU 保留为可选预设。**可以配置不等于已经验证兼容**：学校登录政策、接口权限与平台版本可能限制功能，尤其是 Blackboard Learn Ultra 内部接口。不支持 Moodle、Brightspace 或任意自建教务系统。

## 功能

- 查询课程、通知、作业、考试安排、成绩反馈和课程资料。
- 结合老师通知整理时间表，保留来源链接，标出不确定的时间和适用班级。
- 按需保存本地待办，保留截止时间变更历史，并导出 ICS 日历文件。
- 在 Codex 中自动检查授权；需要登录时打开独立登录窗口，无需复制 Cookie。
- 提供只读 CLI 和 MCP 接口，复用已有的开源 Canvas、Blackboard 连接器。
- 自定义学校网址、显示名称与时区；可只连接一个平台，也可同时连接两个平台。
- 按学校/账号隔离凭据、缓存和本地待办；提供基础连接检查，不把失败当作空数据。

本项目不会提交作业、开始考试、发送消息或修改学校平台中的内容。安装也不会自动开启每日扫描或订阅第三方日历。

## 当前状态

当前源码版本为 **0.3.0 多校预览版**。历史 0.2.0 安装包是 PolyU 专用版，不包含本次多校功能；0.3.0 的安装包及发布标签是否可用，以 Releases 实际内容为准。

- macOS、Windows 和 Linux 的本版本 CI 测试与打包均已通过；具体提交、验证记录及未完成的真实账号验收见 [验证记录](docs/VALIDATION.md)。CI 成功不等于学校登录与全部功能已验收。
- 完整登录、MFA 和实际课程问答仍需要使用者按学校政策验收。
- 安装包尚未签名或公证；请仅从本仓库下载并核对发布说明。
- 尚未发布到公共 npm，也不代表已获 Codex 官方精选市场收录。

详见 [验证记录](docs/VALIDATION.md) 和 [验收清单](docs/ACCEPTANCE.md)。

## 安装

### 1. 准备环境

需要：

- Node.js 22.16 或更新版本，推荐 Node.js 24 LTS。
- 支持插件的 Codex，以及可在终端运行的 `codex` 命令。
- 可以正常访问所选学校 Canvas 和/或 Blackboard 的账号。

Linux 还需要可用的桌面密钥服务。只有服务器终端、没有桌面登录环境的场景暂不作为推荐使用方式。

### 2. 安装 CLI

当前可从源码构建多校版（不需要等候新 Release）：

```sh
git clone https://github.com/zs-andy/lms-cli.git
cd lms-cli
npm ci
npm run pack:cli
npm install -g ./lms-cli-0.3.0.tgz
lms doctor
```

如果已安装旧的 `canvas-blackboard-cli` 包，请先运行 `npm uninstall -g canvas-blackboard-cli` 再安装新包，避免两个包争用 `lms` 命令。卸载 npm 包不删除学校配置和本地凭据。没有公开 npm 发布声明；不要用同名 npm 包替代这里构建的 tarball。

也可从 [Releases](https://github.com/zs-andy/lms-cli/releases) 下载已实际发布的多校版 tarball。请不要省略 optional dependencies：默认安装带上登录窗口所需的 Electron，并优先使用与 CLI 同版的运行时。独立授权 App 名称为 `lms-cli`，不能替代 CLI；使用 `LMS_AUTH_APP` 指向旧版 App 的用户应更新或取消该覆盖。

### 3. 配置学校

将以下示例网址替换为学校的真实平台地址。必须是 HTTPS 根地址，不能包含 `/login`、课程路径、账号或查询参数；时区使用学校所在地的 IANA 名称，不要直接套用示例：

```sh
lms init --id my-school --label "我的学校" --timezone Asia/Hong_Kong --canvas https://canvas.example.edu --blackboard https://learn.example.edu
```

只用 Canvas 就省略 `--blackboard`；只用 Blackboard 就省略 `--canvas`。预设与自定义参数不能混用。PolyU 用户仍可直接运行：

```sh
lms init --preset polyu
```

添加另一个学校/账号不会覆盖原配置，也不会改变已有默认选择：

```sh
lms profiles add exchange --label "交换学校" --timezone Europe/London --canvas https://exchange.instructure.com
lms profiles list
lms profiles use exchange
lms --profile my-school canvas courses
```

第一个配置自动成为默认配置；`--profile` 只选择本次命令，`profiles use` 才改变默认。多个账号即使在同一学校也应使用不同 ID。配置 ID 不可覆盖；地址填错时请新建 ID，避免误用旧凭据。

```sh
lms --profile my-school auth login
lms --profile my-school check
```

`check` 只实时检查身份及课程列表接口，不输出课程/个人资料正文；失败以非零退出码和具体检查项呈现。成功不代表通知、作业、成绩、文件等所有功能已验证。详细兼容范围见 [多校接入](docs/SCHOOLS.md)。

### 4. 安装 Codex 插件

```sh
codex plugin marketplace add zs-andy/lms-cli --ref main
codex plugin add lms-cli@lms-cli
```

这是本项目的 GitHub 插件市场，不是 Codex 官方精选市场。预览源码使用 `main`；正式版本发布后应改用对应已存在的标签，不要将尚未发布的 `v0.3.0` 当作可安装标签。安装完成后，新建一个 Codex 任务，选择「lms-cli」。

如果之前安装了旧市场的版本，先移除相应旧插件，避免重复工具；以下命令只运行与你实际安装来源对应的一条：

```sh
codex plugin remove lms-cli@polyu-lms
codex plugin remove lms-cli@personal
```

### 5. 直接提问

例如：

> 整理本周安排，考虑老师通知里的作业和调课，附上来源。

> 两个平台最近有哪些重要通知？

> 找到这门课的实验说明，告诉我提交要求和评分方式。

首次查询需要授权时，会打开所选学校的登录窗口。请核对显示的学校网址，在窗口中自行完成学校登录和 MFA，不要在聊天中发送密码或验证码。登录完成后，Codex 会继续查询。未指定学校时使用当前默认配置；也可以明确提出「查交换学校的通知」。

还可以让助手添加学校：提供学校名称、平台网址与学校时区即可；配置工具不需要密码，也不会自动替你登录。切换默认学校需要明确提出。

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
- 学校密码和验证码不会保存到项目中，也不会作为工具结果发送给模型。不同学校/账号的凭据与本地待办按 profile 隔离。
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

可以添加其他学校的 Canvas 或 Blackboard 地址，无需修改源码，但需要逐校验收。现阶段没有“所有学校已验证”的承诺；学校限制内嵌登录、不同 Blackboard 版本、额外会话 Cookie 或特殊部署路径可能不兼容。PolyU 预设也不代表学校官方认可。

**旧版配置需要迁移吗？**

0.2.0 的配置格式、默认 `lms-cli` 数据目录和加密凭据命名保持不变；不会自动删除配置、读取旧原型浏览器数据或切换默认学校。新包/新插件名称与旧安装来源的迁移见上面的安装步骤。旧公开标签和 Release 保持历史内容，不会被重写。

## 开发与贡献

```sh
git clone https://github.com/zs-andy/lms-cli.git
cd lms-cli
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

项目代码及项目原创的中性图标采用 [MIT License](LICENSE)。学校名称、Canvas、Blackboard、Codex 等第三方名称或标识属于各自权利人。本版本不再使用 PolyU 校徽作为项目或插件图标；学校预设不代表任何学校认可或授权本项目。
