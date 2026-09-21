# 发布流程

## 分发内容

用户安装以 GitHub Release 中的自包含 CLI 为入口。每个系统和架构对应 `lms-cli-<version>-<os>-<arch>.tar.gz`，包含 Node.js、CLI、连接器及仅供授权使用的 Electron 运行时。Release 同时提供 `SHA256SUMS.txt`，供安装器和更新器验证。

npm tarball 面向已有 Node.js 的环境；独立授权 App 是可选分发项，不是 CLI 安装的前置步骤。Codex 默认通过 `lms setup` 或 `lms connect codex` 注册本地插件。

## 发布前检查

1. 对齐 `package.json`、`package-lock.json`、`src/version.ts`、插件 manifest 与版本标签。稳定版标签使用 `vX.Y.Z`，不带本地缓存后缀。
2. 更新用户文档、隐私说明、验证记录和第三方许可证。平台扩展遵循 [ADDING_A_PLATFORM.md](ADDING_A_PLATFORM.md)。
3. 检查版本控制和打包清单，排除账号、凭据、学校文件、个人路径、日志、`.env` 和备份。
4. 在目标系统运行以下构建与验收命令，并按 [ACCEPTANCE.md](ACCEPTANCE.md) 检查学校授权和查询。
5. 核对签名、公证及系统信任策略。分发说明应明确签名状态；不要要求用户关闭系统安全保护。

## 构建与验证

在待发布提交的干净检出中，使用 Node.js 24：

```sh
npm ci
node node_modules/electron/install.js
npm run typecheck
npm test
npm audit --omit=dev
npm run pack:cli
npm run pack:standalone
npm run verify:standalone
```

自包含包必须在目标系统和 CPU 架构上构建。构建器校验官方 Node 分发包的 SHA-256，并准备完整授权运行时；不要直接复制开发机 Node。`LMS_BUILD_NODE_VERSION` 可指定捆绑的 Node 版本。

`verify:standalone` 在临时目录安装，移除 PATH 中的系统 Node，隔离学校状态和 Codex 配置，检查原生模块、幂等配置、学校搜索、MCP、回退和重装。若能找到 Codex 可执行文件，还会验证真实的本地插件注册。

需要独立授权 App 时另外执行：

```sh
npm run pack:app
```

macOS 直接分发版本使用 Developer ID Application、Hardened Runtime 和 Apple 公证。证书私钥保存在本机钥匙串，不放入仓库或 CI 日志。首次在本机配置公证凭据：

```sh
xcrun notarytool store-credentials lms-cli \
  --apple-id <Apple ID> \
  --team-id <Team ID>
```

随后在 macOS 上执行：

```sh
LMS_MAC_RELEASE=1 \
LMS_MAC_SIGN_IDENTITY='Developer ID Application: <名称> (<Team ID>)' \
LMS_NOTARY_PROFILE=lms-cli \
npm run pack:app:release
```

自包含 CLI 的 macOS 版本也按同一方式签名和公证：

```sh
LMS_MAC_RELEASE=1 \
LMS_MAC_SIGN_IDENTITY='Developer ID Application: <名称> (<Team ID>)' \
LMS_NOTARY_PROFILE=lms-cli \
npm run pack:standalone
```

发布前必须检查 Electron 主程序、Frameworks、Helper、Node、原生 `.node` 模块的 Team ID、Hardened Runtime、时间戳和严格签名；同时运行 `xcrun stapler validate`、`spctl` 和 `codesign --verify --deep --strict`。Windows 签名仍使用分发方证书。不要把本地钥匙串凭据改写成仓库变量或命令行密码参数。

## CI 与 Release

`.github/workflows/ci.yml` 在 Ubuntu、macOS 和 Windows 上完成测试、自包含构建、隔离安装验收及授权 App 构建。工作流实际运行的架构决定产物架构；额外架构需对应 runner 和验收记录。

发布步骤：

1. 确定通过 CI 的源提交，为其创建版本标签及 draft Release。
2. 运行 `Attach verified installers`，提供标签和成功的 CI run ID。工作流核验源文件与标签一致，只向 draft Release 添加附件，不覆盖已有文件。
3. 检查每个声明支持的系统和架构都有对应 CLI 包；将实际附件的 SHA-256 汇总到 `SHA256SUMS.txt`，条目使用准确文件名。
4. 在隔离环境用 draft 产物离线安装，核对版本、首次配置、重复安装、取消、失败恢复和更新数据保留。
5. 完成维护者验收后发布 Release，并检查公开下载、校验和、安装命令及更新提示。记录操作系统、架构、版本、签名状态和学校实测范围。

自动更新读取本仓库最新的非草稿、非预发布版本。缺少对应包或校验和时，只提供发布页面指引；明确请求安装则返回失败。修复已发布产物应增加版本，不重写公开标签或覆盖附件。

## 插件验收

默认接入路径：

```sh
lms connect codex
```

确认本地市场 `lms-cli-local` 已启用，MCP 指向稳定的安装入口。新建 Codex 任务后验证技能和工具；同名插件替换必须经用户确认。升级成功但插件刷新失败时，重新运行此命令即可。

需要直接从仓库市场安装时：

```sh
codex plugin marketplace add zs-andy/lms-cli --ref <已发布标签>
codex plugin add lms-cli@lms-cli
codex plugin list
```

仓库市场方式要求 `lms` 已在客户端 PATH 中，不自动安装 CLI。不要同时启用仓库市场版和本地生成版。公共 npm 发布和第三方市场收录各自有独立流程，不由 GitHub Release 自动完成。
