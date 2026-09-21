# CLI 安装、升级与恢复

0.4.0 以 CLI 为入口。安装、配置、诊断、更新和回退均在终端进行；只有学校 SSO/MFA 可能显示网页。`setup --no-login` 不打开窗口或读取学校私有接口。

## 自包含分发

每个系统/架构独立构建 `lms-cli-<version>-<darwin|linux|win32>-<arm64|x64>.tar.gz`，内含：

- `runtime/`：核对 Node 官方 SHA-256 的运行时及其配套许可证。
- `app/`：编译后的 CLI、连接器、插件与锁定的生产依赖。Electron 在打包时准备好，只在授权时启动。
- `launchers/`：POSIX / Windows 稳定启动器。
- `bundle.json`：版本、系统、架构和 Node 版本。

`npm run pack:standalone` 构建当前系统的包；`npm run verify:standalone` 在临时目录和不含 Node 的 PATH 下验证安装、重复配置、MCP、回退和重装。若机器上存在 Codex，还会在隔离的 Codex 数据目录验证真实插件注册，不影响使用者的插件。

构建默认下载构建机器 Node 版本对应的官方二进制；发布 CI 使用 Node 24。可设置 `LMS_BUILD_NODE_VERSION` 明确选择版本。打包失败不得上传残缺产物。

资产命名支持某个架构不等于已经发布该资产。缺少匹配包时明确停止。Windows 需要 PowerShell 与 Windows 10/11 的 `tar.exe`；macOS/Linux 需要 sh、curl、tar、SHA-256 与常规系统工具。Linux 仍需要兼容 glibc、Secret Service，以及学校网页登录时可用的图形环境；Alpine、纯无图形服务器不属于已验证目标。

## 安装选项

审阅脚本后，可本地执行：

```sh
sh install.sh --version v0.4.0 --no-setup
sh install.sh --dir /absolute/path/lms-runtime --no-path --no-setup
```

PowerShell 对应 `-Version`、`-InstallDir`、`-NoSetup`、`-NoPath`。版本只是示例，必须实际存在。

离线安装：

```sh
sh install.sh --archive /path/lms-cli-0.4.0-darwin-arm64.tar.gz --checksum-file /path/SHA256SUMS.txt --version v0.4.0 --no-setup
```

Windows 对应 `-Archive`、`-ChecksumFile`、`-Version`。校验和必须来自可信发布，不要自行给陌生安装包补写校验和。安装无需管理员权限，不自动卸载全局 npm 包，不覆盖无关同名命令。

POSIX 安装器需要更新 PATH 时先备份 shell 配置，再附加带 `# lms-cli PATH` 标记的两行；撤销时移除这两行即可。Windows 更新用户 PATH 前在安装目录备份原值。`--no-path` / `-NoPath` 跳过 PATH 修改。

## 版本与数据分离

```text
lms-cli-runtime/
  .lms-install       本工具的目录标记
  bin/               稳定启动入口
  current            当前版本，例如 v0.4.0
  previous           上一版本
  versions/v0.4.0/   不原地覆盖的运行时
```

程序目录不同于 `lms doctor` 显示的学校数据目录。学校配置、加密凭据和待办不在 `versions/` 中；不要修改 `LMS_HOME` 来升级程序，否则会选择另一份状态和密钥命名空间。

`lms update` 只在用户确认或给出 `--yes` 后下载安装。只接受本仓库版本对应的 Release URL 和 GitHub 资产 CDN HTTPS 重定向，不执行发布说明中的命令。校验和不匹配、不安全解压路径、错误系统/架构、运行时或授权组件验证失败时，不切换当前版本。

升级会尝试刷新本工具生成的插件；失败会提示 `lms connect codex`。新建 Codex 任务后，才能完整使用新技能与工具。`lms update --rollback` 验证并恢复上一版本，保留学校数据。旧版本不自动清理，避免删除仍在运行或需要回退的文件。

安装/更新使用同一个安装锁。异常断电后先确认相关进程已经退出再修复锁，不删除程序或学校数据根目录。完整删除本工具应先保留需要的数据、退出运行进程，再按明确目录处理；升级不需要删除数据。

## 更新检查和隐私

交互式 CLI 每次使用检查一次；MCP 会话首次 `lms_profiles` 检查一次。检查超时 3.5 秒，失败不影响查询。管道、`--json`、`--offline`、帮助、版本、doctor 不做隐式检查；脚本应明确使用 `lms update --check`。

`LMS_UPDATE_CHECK=0` 关闭自动检查。检查只访问固定 GitHub 公开 Release API，使用通用 User-Agent，不发送学校、账号、课程或凭据。它不下载可执行文件、不启动浏览器、不修改程序。

## 发布门槛

1. 在每个声明支持的系统运行测试、自包含构建和隔离验收。
2. 对齐真实提交与版本标签，汇总安装包到 `SHA256SUMS.txt`，不覆盖旧公开附件。
3. 检查产物不含开发机路径、真实配置、凭据、日志或测试用户数据。
4. 按学校政策验证 SSO/MFA、取消、重试、查询和升级后的授权保持。
5. 明确签名、公证与系统安全提示的状态，不通过关闭系统安全保护包装成“一键”。

发布步骤和资产要求见 [RELEASING.md](RELEASING.md)。
