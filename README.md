# Limcode Test

Limcode Test 是基于 [LimCode](https://github.com/Lianues/limcode2) 演进、由 [lurenxing628](https://github.com/lurenxing628) 独立维护的衍生项目。当前仓库独立管理发布与开发历史，并使用独立的扩展、命令、视图及数据命名空间，可与原版同时安装。

- 当前仓库：[lurenxing628/limcode-test](https://github.com/lurenxing628/limcode-test)
- 上游来源：[Lianues/limcode2](https://github.com/Lianues/limcode2)
- 开源许可：[GNU GPL v3](LICENSE)

## 和原版的区别

Limcode Test 不是简单改名。它仍然是在 VS Code 中使用的对话助手，但对话如何运行、保存和恢复已经和原版有很大区别，主要部分都重新做过。

具体重做的内容：

- 重新设计了对话的运行和保存方式，让消息、工具操作和任务状态都有清楚记录。
- 重新做了中断和恢复。对话被打断、工具超时或程序重开后，可以接着原来的任务，减少丢消息、重复执行和一直等待。
- 重新做了长对话处理。打开长对话时先显示最近内容，内容过多时整理较早部分，并尽量保留当前任务和重要结果。
- 重新做了工具、文件和后台任务的执行过程，补上结束确认、临时文件清理和意外退出后的处理。
- 重新做了子助手协作，让它们能独立完成部分任务并把结果带回原对话，同时限制创建层数。
- 重新做了历史记录、附件、本地图片和设置同步，并改进启动、滚动和展开内容时的速度。
- 删除了原来的旧运行代码，统一使用新的运行方式。

其他工作：

- 增加了自动测试、多系统检查和性能测量。
- 整理了提交历史和开发规则，完善了项目文档，并迁入奥德赛组织，方便多人分开修改、一起维护。

## 当前能力

- Vue / Pinia Webview 通过 bridge 发送命令；VS Code 应用层把命令交给可靠内核，不再运行旧 ECS chat systems。
- `ReliableKernelApplication` 组合 Turn、Effect、Tool、Process、Context 与子代理控制面；SQLite worker 统一提交运行事实，外部能力通过 LLM / MCP / 文件 / 进程适配器执行。
- 对话、消息、执行状态和关系分别保存在 Runtime SQLite 的独立领域表中；正文、附件和工具大结果保存在 CAS。不存在 JSON conversation chunks 与 SQLite 双写。
- Webview 接收有界 snapshot / changes；长历史和大内容按需读取，不把整段历史随每次更新重发。
- Agent、Workflow、Policy、模型配置和 Settings 保持独立配置权威。LLM 渠道记录位于当前配置根的 `settings/llm-provider-configs/index.json` 与 `records/`，由设置页管理。
- 数据路径统一由 `getPaths()` 和 RootAuthority 解析；Runtime 长连接持有完整、带 fencing 的 RootBinding，不能自行从 `globalStorageUri` 拼接业务路径。
- 文件传输默认允许项目外路径；用户显式关闭 `allowOutsideProjectPaths` 时，源与目标必须真实位于各自工作环境根内，不能借符号链接绕过。
- `read` 支持本地 20 MiB、远程 2 MiB 内文本的行范围读取，按 256 KiB 行切片预算返回；单行超出切片预算时仍返回该行。远程传输使用无损字节流，超限报错，不把截断内容当作完整文件。
- Windows 命令优先使用已验证版本的 PowerShell 7，缺失时使用 Windows PowerShell 5.1。长脚本通过 UTF-8 暂存文件传输，在进程身份确认后作为命令文本执行，保留 Unicode、真实退出码和错误诊断。
- 渠道和模型可分别配置重试间隔：`0` 使用自动指数退避，`1–600` 为固定等待秒数；模型专属配置可以用 `0` 覆盖渠道的固定间隔。

> 当前开发阶段 LLM API Key 仍随渠道配置记录明文保存，不使用 VS Code SecretStorage；请勿分享包含密钥的配置目录。

## 支持平台

Release 提供以下本地 VS Code Extension Host 制品：

- Windows x64
- Linux x64
- macOS x64（Intel）
- macOS arm64（Apple Silicon）

各平台 VSIX 均包含对应的 `better-sqlite3` 原生模块；请按操作系统和 CPU 架构选择安装包。

## 快速开始

```bash
npm install
npm run build
```

然后在 VS Code 中按 `F5` 启动 Extension Development Host。

常用命令：

```text
Limcode Test: Open LLM Chat
Limcode Test: Reveal Data Storage Folder
Limcode Test: 历史与存储管理
```

同一数据目录固定使用一个当前历史库，增减工作区文件夹不会切换历史，工作区只作为任务执行环境。首次启动自动确定可用的当前库，其它旧来源登记为待合并并在后台逐份合入；超出后台合并上限时，可在“历史与存储管理”中选择“立即合并全部”。冲突、缺少正文或仍有未完成工作的对话保留在“未能合并的旧数据”中，可以只读查看或重新合并；不会为了合并而丢弃这些内容，也不提供旧库选择、切换或保留分库入口。

已发布的 Runtime epoch 3（v0.0.10–v0.0.14）、epoch 4（v0.0.15–v0.0.21）和 epoch 5（v0.0.24–v0.0.36）都可直接升级到当前 epoch 6，无需逐版安装。扩展先核对旧库的身份与完整结构、持久备份 SQLite，再离线升级原库；原有对话、消息、附件、CAS、配置和工作区保留。旧版已中断的 3→4 或 3/4→5 升级会先按原日志收敛，再升级到 6；本次升级中断也会在下次启动时继续。未知结构或身份异常会保留原数据并报告错误，不会以归档重置或空库替代升级。外来归档和拷来目录只在私有副本中升级后核验、查看或合并，原件不改动。

升级无需用户点击按钮或确认：当前库在启动时处理，其它旧库在启动完成后自动逐个处理，查看旧历史时也会自动补做。某个旧库出错不会挡住其它正常旧库，失败原因可查看。正在被其它窗口使用的旧库会保留，待其退出后才能升级；升级非当前旧库不会切换当前库或启动其中的旧任务。

“历史与存储管理”还提供查看存储占用、检查并修复当前历史、迁移数据目录、清理备份和归档并重置当前历史。历史检查先只读，确认后才备份并修复；清理备份只删除当前历史已完整覆盖的普通备份，以及已完整合并且未改变的旧来源。待合并、部分合并和残留数据保留。新的归档重置备份登记为残留，可只读查看或明确重新合并，不会自动合并或删除；归档保留完整正文与附件，本身不会释放这些空间。

迁移数据目录只复制当前历史、设置、全局规则和技能；其它旧来源留在原位置，待合并和残留登记跟随新目录。旧目录默认保留；删除旧目录时只删除确实迁入且之后未改变的内容，未迁入来源和独立备份保留。

工作目录按会话显式选择、继承、绑定项目、保存的默认值和唯一候选确定，失效时会提示重新选择；已开始的回合保留原目录。

## 协作开发

- 从 `main` 创建独立分支进行开发。
- 通过 Pull Request 合并改动，不直接改写已经共享的历史。
- 提交消息只写简明中文标题，不添加类型前缀，也不写正文。
- 提交前运行 `npm run check:plan:tracked` 检查构建、类型和合同；行为回归另运行 `npm run check:local` 或相关测试。合同检查通过不代表运行时或真实安装验收通过。

## 常用脚本

```bash
npm run compile          # 编译扩展后端 TS
npm run watch            # 监听并编译扩展后端 TS
npm run dev:webview      # 启动 Vue Webview Vite dev server
npm run build:webview    # 构建 Webview 静态资源
npm run build                  # 编译后端 + 构建 Webview
npm run check                  # 构建、类型检查和可靠内核计划合同校验
npm run check:local            # 在上述校验后，再运行本地测试
npm run package:linux          # 打包 Linux x64 VSIX
npm run package:win32          # 打包 Windows x64 VSIX
npm run package:darwin-x64     # 打包 macOS Intel VSIX
npm run package:darwin-arm64   # 打包 macOS Apple Silicon VSIX
npm run package:all            # 构建与裁剪一次，打包上述四个平台
```

项目的 `package:*` 入口会准备最新产物，单次 `package:all` 共用这一份产物。直接使用 `vsce package` 只打包已有产物。扩展编译、watch 成功轮次与 webview 构建完成后更新同一个 buildId；运行中的扩展保留装载时的身份，重新构建后提示重载，不扫描源树和模块正文来生成证明清单。

## 目录概览

```text
backend/application/     # VS Code 产品组合根、命令路由与配置协调
backend/reliableKernel/  # Runtime 控制面、SQLite worker、CAS 与 Client Feed
backend/capabilities/    # LLM、文件、进程、网络及配置存储适配器
backend/world/           # 当前仍复用的领域类型、工具声明和 prompt helper；不是运行主循环
shared/                  # Webview 与扩展共享协议
vscode/                  # VS Code extension entry、commands、panels、views
webview/                 # Vue Webview 前端
docs/                    # 架构与开发约束说明
```

## 架构文档

- [新运行系统架构](docs/architecture/reliable-kernel/README.md)：当前运行架构、约束合同和检查规则。
- [Conversation 可靠存储权威模型](docs/conversation-storage-authority.md)：旧文件后端的历史说明，不是当前 SQLite 写入规范。
- [模型上下文投影、中断与压缩一致性](docs/model-context-projection.md)：旧 Provider/Context 实现的历史说明；当前以可靠内核合同为准。
- [后台进程 completion 可靠注入语义](docs/background-process-reliability.md)：旧后台进程实现的历史说明；当前使用可靠内核 Process/Effect/Delivery 链路。
