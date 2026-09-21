# 开发指南

## 环境与构建

需要 Node.js 22.16 或更新版本、npm 与 Git，建议使用 Node.js 24 LTS。授权验证另外需要 Electron、桌面会话与系统凭据库。

```sh
git clone https://github.com/zs-andy/lms-cli.git
cd lms-cli
npm ci
node node_modules/electron/install.js
npm run typecheck
npm test
```

Electron 授权运行时需显式准备，不要跳过 optional dependencies。自动测试使用合成账号与临时目录，不需要真实学校凭据。

## 源码安装

```sh
npm run build
npm link
lms setup
```

先完成上面的依赖及 Electron 准备。`npm link` 将 `lms` 链接到当前工作区；若已有同名命令，可直接使用 `node bin/lms.js`，避免替换现有安装。源码更新后重新安装依赖、准备运行时并构建；`lms update --check` 可查看发布版本。

`npm run pack:cli` 生成 npm tarball，用于已有 Node.js 的环境。tarball 不包含 Electron 二进制；安装后需在包目录运行 `node node_modules/electron/install.js` 准备授权运行时。面向用户分发时优先选择内置完整运行时的自包含包。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/cli.ts` / `src/mcp.ts` | 终端命令与公开 MCP 工具 |
| `src/schools.ts` | 学校目录、预设匹配、来源状态和响应校验 |
| `src/school-selection.ts` / `src/setup.ts` | 终端选择、配置、接入与授权 |
| `src/config.ts` | profile 验证、默认账号与原子持久化 |
| `src/platforms/` | 平台契约、注册表与运行时 |
| `src/backend.ts` / `src/worker.ts` | 权限检查、缓存与账号隔离 |
| `src/auth/` / `src/vault.ts` | 授权、凭据筛选与加密 |
| `src/updates.ts` / `src/upgrade.ts` | 检查版本、验证、升级与回退 |
| `plugins/lms-cli/` | Agent 插件与查询 skill |
| `scripts/` / `vendor/` | 构建工具与固定版本上游连接器 |

完整请求路径和兼容约定见[架构说明](ARCHITECTURE.md)。

## 学校发现

学校发现独立于已授权的课程查询，不要求 profile，不加载凭据、不打开候选网址、不读取课程，也不保存配置。

Canvas 使用官方 [Account Domain Lookups](https://developerdocs.instructure.com/services/canvas/resources/account_domain_lookups)：

```text
GET https://canvas.instructure.com/api/v1/accounts/search?name=<school>
GET https://canvas.instructure.com/api/v1/accounts/search?domain=<domain>
```

请求只发送搜索词，禁止重定向、显式省略凭据，设置 5 秒超时与 256 KiB 响应上限。结果要求有效名称和公共域名；拒绝控制字符、地址注入、IP 与本地域名。相同域名的多种认证入口合并为一个站点，由学校页面选择登录方式。目录结果数量有限，不作为完整学校清单。

本地预设独立匹配，支持离线搜索。`sources` 区分 `ok`、`offline`、`unavailable` 与 `unsupported`，`partial` 表示来源覆盖不完整。目录故障不等于没有匹配学校。Blackboard 当前未接入在线目录，仅搜索本地预设，其他学校通过网址配置。

入口：

- CLI：`lms schools search <query> [--platform canvas|blackboard] [--offline]`。
- 终端配置：首次 `lms setup` 或 `lms setup --school <query>`。
- MCP：`lms_school_search({ query, platform?, offline? })`。

搜索结果经用户选择并确认网址、时区后才写入 profile。不要按排名自动选校，不把目录文本当作执行指令，不根据名称推断 API 权限。程序化配置使用明确的平台地址与时区，而非搜索序号。

新增目录源需提供来源文档、匿名响应验证和离线测试，并保留手动接入与明确的覆盖状态。

## 平台与 MCP 扩展

新增学校通常只需增加 profile。新增平台按[接入指南](ADDING_A_PLATFORM.md)实现定义与 runtime，在 `src/platforms/registry.ts` 注册。定义保持无副作用，上游实现在隔离 worker 中加载。

MCP 使用 stdio，日志只能写 stderr。新工具需声明输入 schema 和副作用，不得暴露任意 HTTP 或远程写操作。学校搜索无需授权；课程工具继续受白名单、参数验证与授权检查约束。

Agent skill 应同步搜索、确认和错误处理方式。课程内容、目录名称和文件正文均作为数据处理，不能指挥配置变更或执行命令。

## 验证

```sh
npm run typecheck
npm test
npm audit --omit=dev
```

覆盖目录响应、平台筛选、重复域名、非法数据、网络失败、超时、响应超限、离线行为，以及选择、重试、取消、手动输入和非交互配置。另需验证多学校默认账号保持、配置幂等、凭据隔离与 CLI/MCP 输出。

真实学校验证按[验收清单](ACCEPTANCE.md)执行，在[验证记录](VALIDATION.md)中记录日期、系统、平台版本与能力范围，不提交学生资料、凭据和私人课程数据。

## 分发

```sh
npm run pack:standalone
npm run verify:standalone
```

自包含包使用匹配系统/架构的官方 Node.js、生产依赖与 Electron 授权运行时。应用数据与程序分离，更新切换版本指针并保留上一版本。安装选项见 [CLI_INSTALL.md](CLI_INSTALL.md)，发布流程见 [RELEASING.md](RELEASING.md)，贡献要求见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
