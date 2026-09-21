# 架构与扩展边界

本文面向维护者和贡献者。新增学校配置见 [SCHOOLS.md](SCHOOLS.md)；接入一个新的 LMS / 上游 MCP 见 [ADDING_A_PLATFORM.md](ADDING_A_PLATFORM.md)。

## 设计原则

- 一个平台一份定义、一份运行时；学校差异放在 profile，不复制平台实现。
- CLI 和公开 MCP 共用 Backend；不为每个客户端重复业务逻辑。
- 平台定义可被主进程安全加载；上游实现只在隔离 worker 中加载。
- 明确列举允许的只读工具；不信任工具名规律或 MCP `readOnlyHint`。
- 错误、分页上限和不支持的能力显式返回，不能替换为空成功结果。

## 请求路径

```text
CLI / MCP 客户端
      │
      ▼
cli.ts / mcp.ts ─── config.ts / auth/ / items.ts
      │                  │
      ▼                  ▼
backend.ts        platforms/registry.ts
  │ 校验权限/参数        │ 统一平台定义
  │ 限流/缓存/错误       ├── canvas/index.ts
  ▼                      └── blackboard/index.ts
worker.ts（每个 profile × platform 隔离进程）
  │
adapter.ts ─── vault.ts（加密、账号/来源隔离、凭据代次检查）
  │ 延迟加载
  ▼
platforms/<id>/runtime.ts
  │
vendor/<id>/ 或固定版本依赖 → 学校 HTTPS API
```

`registry.ts` 的 `platformDefinitions` 是唯一注册入口。平台 ID 类型、Zod 平台枚举、profile 平台字段、CLI 配置参数和快捷命令、登录页选项、工具归属、登录 Cookie 策略、身份/课程探针及概览计划都由它派生。

## 目录职责

| 位置 | 负责什么 | 不应该做什么 |
| --- | --- | --- |
| `src/platforms/types.ts` | 平台定义、凭据与运行时契约 | 引入 vendor、启动连接、读取凭据 |
| `src/platforms/registry.ts` | 静态注册、唯一性校验、工具归属、环境命名空间 | 接受用户传入的可执行程序或动态插件路径 |
| `src/platforms/<id>/index.ts` | 平台元数据、白名单、别名、探针、概览 | 顶层导入运行时、执行网络/磁盘操作 |
| `src/platforms/<id>/runtime.ts` | 环境配置、凭据适配、身份验证、启动上游 MCP | 修改公共 profile、直接绕过 vault 写入凭据 |
| `src/platforms/overview.ts` | 合并有界概览计划、报告覆盖缺口 | 解释课程正文或推断截止时间 |
| `src/adapter.ts`、`src/worker.ts` | worker 生命周期、凭据边界 | 用平台名称分支实现上游逻辑 |
| `src/backend.ts`、`src/policy.ts` | 只读权限、JSON Schema 校验、缓存、并发、错误封装 | 按工具前缀猜平台、吞掉上游错误 |
| `src/auth/`、`src/vault.ts` | 通用登录 UI、安全 Cookie 筛选、加密状态 | 保存学校密码/IdP Cookie、明文降级 |
| `src/schools.ts`、`src/school-selection.ts` | 公开学校目录、预设合并、终端选择 | 携带凭据、自动选择结果、自动写配置 |
| `src/setup.ts`、`src/terminal.ts` | 幂等配置、显式确认、必要授权与连接检查 | 静默替换账号或切换默认账号 |
| `src/codex.ts`、`src/runtime.ts` | 本地插件注册与稳定启动配置 | 覆盖未确认的同名插件或无关客户端配置 |
| `src/updates.ts`、`src/upgrade.ts` | 固定来源检查、校验下载、版本切换与回退 | 执行发布说明、修改学校数据、未经确认升级 |
| `vendor/` | 固定版本上游实现及许可证 | 混入面向本项目的跨平台调度逻辑 |
| `src/platforms/_template/` | 参与类型检查的未注册模板 | 被当作已经支持的平台 |

## 元数据与运行时必须分离

学校发现是独立的公开元数据路径，不需要 Backend、学校配置或授权。Canvas 使用官方 Account Domain Lookups 接口；Blackboard 仅查询预设。目录返回的名称与地址经过清理、去重和数量限制，再由用户核对网址与时区。手动输入保留为独立入口，不通过猜测私有 API 扩大学校覆盖。

安装器和更新器共用托管目录及锁。`versions/` 保存独立运行时，`current` 为稳定启动器读取的版本指针；新版本通过校验和、解压边界和独立 `doctor` 检查后才切换指针。学校数据位于单独的状态目录。自动版本检查只返回通知，升级和回退需要确认。

主进程会为帮助信息、工具策略、MCP 参数和登录页面加载所有平台定义。这些定义必须无副作用。`loadRuntime()` 只有 worker 使用；上游若在模块初始化时读环境或启动 stdio，必须推迟到 `configure()` 后的 `validate()` / `serve()` 内导入。

同一 worker 只服务一个学校账号的一个平台。凭据变化后 Backend 关闭旧连接并创建新 worker，避免上游全局环境或模块缓存串账号。平台持久化只能使用 `install()` 提供的 `persist` 回调；回调携带凭据代次，旧 worker 不能覆盖新登录，也不能在注销后恢复会话。

注册表是维护者审查过的源码清单，不是第三方代码沙箱。worker 隔离全局状态，但并不隔离恶意依赖的文件系统权限。新增上游仍需依赖、许可和安全审查。

## 权限与失败语义

Backend 同时检查“工具被允许”和“工具属于所连接的平台”。上游新增工具不会自动公开。调用参数由上游 JSON Schema 验证；未知参数拒绝发送。平台 HTTP 层仍需独立禁用写操作，并防止分页/重定向跨域携带凭据。

公开 `lms_batch` 仍只接受 1–8 次调用、最多 3 个并发。内部概览每个平台最多 8 次调用，合并后仍最多 3 个并发，不会因第三个平台加入而触发公开批量上限。不支持概览的平台出现在 `unsupportedPlatforms` 中，结果 `ok: false`、`partial: true`，而不是“没有安排”。

调用结果保留 profile、platform、origin、timezone、抓取时间、缓存状态及覆盖说明。批量中的未知/禁止工具没有已审核归属，`platform` 为 `null`。连接检查仅返回状态，不返回个人资料和课程正文。异常内容经过公共错误边界，不能原样输出包含凭据的上游诊断。

## 兼容性约定

- 当前真实支持的平台仍为 Canvas、Blackboard；扩展接口不代表新增平台已经可用。
- 已发布平台 ID、CLI 命令、上游工具名和 profile 字段保持不变。
- 现有配置版本仍为 `1`，无需迁移；未注册字段仍被严格拒绝。
- 旧 Canvas / Blackboard profile 的 vault 文件名与认证附加数据保持不变。只有配置了新平台的 profile 才附加排序后的新平台 ID/来源，保证新来源参与隔离。
- PolyU 仅是现有学校预设；`auth token` 仍是历史 Canvas 专用入口。这两处以及旧 vault 键格式是有意保留的兼容边界，不是新增平台需要复制的分支。
- 概览新增 `scope.platforms[platformId]`；原有平台的旧 scope 字段由各自定义中的 `legacyScope` 保留。新平台不要增加顶层遗留字段。
- 当前契约支持 HTTPS 根来源及现有 Cookie 登录流程；OAuth、远程 MCP、非根路径部署等需要单独设计，不应藏在一个 runtime 中绕过安全边界。

## 验证层次

1. `npm run typecheck`：所有平台和模板必须符合统一接口。
2. `test/platforms.test.ts`：注册表、工具归属、概览、环境清理、导入边界。
3. `test/core.test.ts`、`test/backend.test.ts`：profile、vault、Cookie、参数/错误/缓存隔离。
4. `test/integration.test.ts`：真实上游离线握手、公开 MCP、CLI 参数与模板扩展。
5. `test/auth-ui.test.ts` 和离线 UI 检查：学校/平台切换与文本安全。
6. `test/schools.test.ts`、`test/setup-update.test.ts`、`test/upgrade.test.ts`：搜索、选择、幂等配置、插件注册、更新事务与回退。
7. `npm run verify:standalone`：无系统 Node、隔离状态目录的安装与 MCP 验收。
8. 获授权的使用者按 [验收清单](ACCEPTANCE.md) 进行真实学校验证；离线测试不能替代 SSO/MFA、平台版本及接口权限验收。
