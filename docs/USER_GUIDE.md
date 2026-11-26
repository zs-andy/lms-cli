# 用户指南

`lms-cli` 在本机连接学校的 Canvas 或 Blackboard，通过终端或 Agent 查询课程、通知、作业、反馈与资料。学校配置、授权凭据和本地待办独立于程序目录保存。

## 安装与首次配置

使用 [README](../README.md) 中对应系统的安装命令。安装器下载匹配系统和 CPU 架构的稳定版自包含包，验证 SHA-256 后安装；包中内置 Node.js 和授权运行时，无需预装 Node.js、npm 或 Git。目标平台需要有已发布的安装包和校验和。

若安装后配置未启动，打开终端运行：

```sh
lms setup
```

1. 输入学校名称或域名，查看名称、平台、网址和来源。
2. 输入编号选择，核对平台地址和学校时区，例如 `Asia/Hong_Kong`。
3. 完成 Codex 接入；独立使用 CLI 时添加 `--no-codex`。
4. 必要时在学校页面完成登录/MFA；有效授权会被复用。
5. 查看身份和课程列表检查结果。

密码和验证码只在学校页面输入，不应进入命令参数、聊天或日志。取消登录后配置仍保留，按输出提示运行 `lms --profile <id> setup` 可继续；只有一个默认账号时也可直接运行 `lms setup`。

```sh
lms setup --school "Hong Kong"
lms setup --school "City University" --platform canvas
lms setup --offline             # 仅搜索本地学校预设
lms setup --manual              # 手动填写平台网址
lms setup --no-login            # 不登录、不读取学校私有接口
lms setup --no-codex            # 不修改 Codex 接入
```

`--offline` 控制学校目录搜索；完全本地配置时同时使用 `--no-login --no-codex`。Canvas 搜索会将名称或域名发送给官方目录，不发送账号和凭据。Blackboard 当前使用本地预设和手动网址接入。详见[学校与账号](SCHOOLS.md)。

## 实验性记住密码与自动登录

每次需要授权时，直接显示学校自己的登录页面和后续身份服务页面；没有替代学校登录的统一密码页。顶部的两个选项均默认关闭：**记住密码**会在下次自动填充，由你点击登录；**自动登录**同时启用记住密码，填充后等待 2 秒再自动提交。首次勾选后，需要成功完成一次学校登录，才会保存密码。

这些是实验性功能，覆盖标准表单、常见登录按钮、分步账号／密码、精确匹配的 HTTPS 跨域提交，以及特征匹配的 Microsoft ADFS 页面，不保证所有学校兼容。账号密码在本机加密保存，不发送给模型。开启记住密码会保留本应用按 profile/platform 隔离的登录分区，让学校允许的“记住此设备”状态持续有效。

修改已填入的账号或密码、取消勾选自动登录，会停止后续自动提交；点击取消或按 Esc 会结束本次登录并关闭 SSO 弹窗。取消不能撤回已发送的请求。取消记住密码会删除密码、TOTP 密钥和登录分区；运行 `auth logout` 删除本地授权、密码、TOTP 及偏好，旧登录分区会在下次授权窗口启动时清理。两者均不会撤销学校服务器上的会话。

若学校提供 TOTP 密钥，可将密码管理器的输出经私密管道传给 `lms auth totp --platform blackboard --stdin`，不要将密钥写入命令参数、shell 历史或聊天。自动登录只会在已验证登录链中的验证码页填入并提交一次。使用 `lms auth totp --platform blackboard --clear --yes` 可删除密钥。CAPTCHA、推送确认及设备合规检查仍需用户完成。

## 接入 Agent 客户端

`setup` 默认连接 Codex。单独修复接入，不打开学校登录页面：

```sh
lms connect codex
```

接入后在新的 Codex 任务中使用。本机插件市场 `lms-cli-local` 使用绝对启动路径，不依赖桌面程序继承终端 PATH。检测到其他来源的同名插件时，先核对冲突，再运行 `lms connect codex --replace-plugin`。

其他 MCP 客户端使用：

```sh
lms mcp-config
```

将返回配置加入客户端。绝对路径只适用于当前电脑，不应提交到仓库。MCP 使用标准输入/输出通信，不混入终端提示。

## 查询

```sh
lms canvas courses
lms blackboard courses
lms overview --days 7 --fresh
lms tools --query feedback
lms tools --name bb_get_grade_detail
lms ask "本周有哪些作业截止？请检查老师通知并附来源。"
```

只运行已配置平台的命令。结构化查询默认输出 JSON；`lms ask` 输出自然语言回答，需要已登录的 Codex CLI。模型服务费用与额度由所选账号决定。

概览有分页与通知数量上限，文件附件按需读取。学期周次、模糊时间和分组安排需核对原文。接口读取失败会返回错误，不表示没有课程或事项。

在 Agent 客户端中，也可以直接提出：

> 比较老师最近两次通知，列出作业要求和截止时间的变化，附上来源。

## 本地待办与日历

明确要求保存后，事项才会写入本地待办；它不会写回学校平台或自动订阅外部日历。

```sh
lms items list
lms items export --out semester.ics
```

ICS 仅包含时间明确且已确认的事项，已有同名文件不会覆盖。导出的日历属于普通文件，应自行保管。程序化输入见 [items.example.json](items.example.json)。

## 更新与回退

```sh
lms update --check
lms update
lms update --yes
lms update --rollback
```

自动检查只提示，不安装；`--yes` 明确确认升级。更新验证来源、SHA-256、架构和运行时后切换活动版本，保留上一版本。学校配置、凭据和待办不随版本切换删除。

升级后重新启动 CLI 或创建新的 Codex 任务。插件刷新失败时运行 `lms connect codex` 重试。自动升级适用于自包含安装；源码安装按[开发指南](DEVELOPMENT.md)重新构建和安装。

交互式 CLI 与 MCP 会话首次配置查询默认向本项目 GitHub Release 页面检查稳定版（不占用 GitHub API 匿名额度），页面不可用时退回 Release API。帮助、版本、诊断、管道、`--json` 和 `--offline` 不隐式检查。`LMS_UPDATE_CHECK=0` 关闭自动检查；显式的 `lms update --check` 仍会联网。网络不可用时显式检查会报告失败，自动检查不影响课程查询。

## 诊断与故障排查

### 命令或客户端连接不可用

```sh
lms doctor
lms connect codex
```

若当前终端未识别 `lms`，重新打开终端，或使用安装器显示的绝对路径。`doctor` 检查本机运行时，不访问学校账号。其他 MCP 客户端使用 `lms mcp-config` 的配置。

### 搜不到学校

尝试学校英文名、简称或平台域名；中文匹配取决于目录收录。理大预设另有中文别名。目录结果有限，可缩小关键词。仍未找到时，使用 `lms setup --manual` 填入学校公布的平台根地址。

### 登录后仍无法查询

```sh
lms auth status
lms check
lms setup
```

`auth status` 查看保存的授权状态；`check` 实际读取身份和课程列表，不打开窗口。会话过期时通过 `setup` 重新授权。学校策略、接口权限和 Blackboard 版本差异需根据具体错误处理。

Linux 需要 Secret Service 保存加密密钥；网页登录需要桌面会话。无图形会话时可用 `--no-login` 完成本地配置。学校禁止内嵌登录时，应遵守其访问策略。

### 退出登录

```sh
lms auth logout --platform canvas --yes
lms auth logout --platform blackboard --yes
```

只删除本地对应平台的凭据，不撤销学校服务器会话，不删除待办、下载文件或导出日历。使用 `--profile <id>` 可指定其他账号。数据保存与清理见 [PRIVACY.md](../PRIVACY.md)。

## Download original Canvas & Blackboard files

`canvas_read_file` and `bb_read_file` extract text. To save a complete PDF, Office document, ZIP, or other original file locally, use `lms_download_file` (MCP) or `lms download` (CLI). Neither operation changes Canvas or Blackboard.

```sh
# Canvas
lms --profile <profile-id> download <file-id> --directory /absolute/destination
lms --profile <profile-id> download <file-id> --directory /absolute/destination --filename lecture.pdf --on-conflict error

# Blackboard
lms --profile <profile-id> download <content-id> --platform blackboard --course <course-id> --directory /absolute/destination
lms --profile <profile-id> download <content-id> --platform blackboard --course <course-id> --source-file slides.pdf --directory /absolute/destination --on-conflict error
```

For full low-level schemas, run `lms tools --name canvas_download_file` or `lms tools --name bb_download_file`, then call `lms call <tool> --args '<JSON object>'`. `directory` must be absolute; `filename` must be a filename without directory separators. The default conflict policy renames the new file. `on_conflict=error` fails on an existing name. Neither policy overwrites existing files. Successful results include `path`, `filename`, `bytes`, `sha256`, `source_url`, and the download timestamp.

MCP clients use the dedicated `lms_download_file` tool with `profile` and `directory`, plus either `file_id` (Canvas) or `courseId` + `contentId` (Blackboard, with optional `source_file` when an item has multiple files); optional parameters are `platform`, `filename`, `on_conflict`, and `max_bytes`. This tool is annotated as a local write. Read-only `lms_call` and `lms_batch` reject file-saving operations. Downloads are neither cached nor coalesced. The default limit is 512 MiB, configurable up to 1 GiB through `max_bytes`. Downloads have a five-minute total budget; clients should allow at least 360 seconds for large requests.

Downloads reuse the existing school authorization flow. Only same-origin Canvas or Blackboard requests carry credentials; requests redirected to a CDN or off-origin storage do not. Bytes are streamed into a private temporary directory, checked against size metadata, unexpected HTML, and PDF signatures where applicable, then published atomically without replacing an existing file. Failed transfers clean up temporary files. A retry starts from zero; resumable downloads are not implemented. Forced termination or power loss can leave a `.lms-download-*` directory; remove it only after confirming that no download is using it.

If `canvas_list_files` receives 403, it checks module file references and same-origin links in up to five accessible course pages, with explicit partial-coverage notes. Omitted module items are fetched through their paginated endpoint; the page-list fallback reads at most one page of ten entries. A discovered reference does not guarantee permission to read the file: Canvas still decides access. Download links may require the current session and are not guaranteed to work anonymously. External video services and third-party platforms are outside this feature.
