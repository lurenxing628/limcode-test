# 已发布 epoch 3/4 历史库恢复审计

审计日期：2026-09-26。基线提交：`11ce63e195c667c78154e8560e598a1024f69b01`，package 0.0.28、Runtime epoch 5。

审计时用户无法联系受影响用户，本轮直接研究正式 tag、历史源码与现有入口，使用独立夹具验证。要求是优先恢复旧数据可用性，直接自动备份升级，不增加升级按钮或确认步骤。本文记录历史格式、修复前证据和本轮自动行为；截至 2026-09-26 本地验收，实现、编译与定向回归已完成，结果见 §8，当时尚未发布。后续发布状态以 [GitHub Release](https://github.com/lurenxing628/limcode-test/releases) 为准。本次验收没有访问客户实际数据；不能据此认定客户数据已经恢复或入口缺陷就是客户故障的唯一原因。

## 1. 已确认的结论

1. **原位无损迁移已经存在。** 提交 `c1d9a737da08a58c64d0b5c88fa42286cd9a92ab` 实现精确 epoch 3/4→5 离线迁移，正式 v0.0.24–v0.0.28 均包含该提交。不能把“缺少升级引擎”当作当前问题，也不能声称正式 0.0.24/0.0.25 会自动把旧库归档后换成空库。
2. **12 个正式旧 tag 的物理 DDL 全部符合当前迁移所接受的指纹。** 使用各 tag 自己的 schema 生成器建立内存 SQLite，再运行当前物理指纹校验，全部通过。对应领域 manifest 对象逐项比较也匹配当前接受的历史变体。
3. **基线 v0.0.12 的历史变体名称标错，但不会因此拒绝迁移。** 实际 detail 范围是 v0.0.10–v0.0.12，summary 范围是 v0.0.13–v0.0.14。本轮按该范围纠正标注；校验仍接受任一完整精确变体，不按名称中的版本号选择，接受行为不变。
4. **修复前入口缺陷已复现并修复。** 维护锁失败留下的空 scope，以及归档后未初始化新库留下的 backups-only scope，会使修复前全数据集枚举失败；未选中的 epoch 3/4 又被只读历史入口拒绝。新流程隔离单库异常，启动后自动批量备份升级其它旧库，读历史时自动补做；最终定向回归通过，详见 §8。
5. **原位升级与移动备份恢复是不同操作。** RootBinding 保留规范绝对路径，并与 SQLite 中的路径逐字段核对。将旧目录挪位置、只复制 SQLite，或跨平台直接打开旧指针，即使 schema 正确，也不能直接套用原位迁移。

## 2. 固定来源与全部正式 tag

表内 commit 使用 `git rev-parse '<tag>^{}'` 解引用；例如 v0.0.21 是带注释 tag，其 tag 对象 ID 与实际提交 ID 不同。以下是仓库 tag 源码审计，不等同于逐个重新下载、解包并校验所有历史 VSIX。

| Tag | Commit | Epoch | 格式组 | 物理 DDL 校验 |
|---|---|---:|---|---|
| v0.0.10 | `efc150f554b2ab9d5aefd0f55dc64b96b320f3b6` | 3 | E3-detail | 通过 |
| v0.0.11 | `cf74020bcdb48781a9bebb1a8a4275fcd0e7f051` | 3 | E3-detail | 通过 |
| v0.0.12 | `222c3f01de86e6ae53242392ce3882b7a2751d29` | 3 | E3-detail | 通过 |
| v0.0.13 | `63cf17f05db23cc20d1c3aea720d83fb5179d359` | 3 | E3-summary | 通过 |
| v0.0.14 | `94c2e57e267a743cc0a691a970823c9fe89450e1` | 3 | E3-summary | 通过 |
| v0.0.15 | `5a3ddf7dcbf4523c0494ee1f5670ffc01262f080` | 4 | E4-complete | 通过 |
| v0.0.16 | `679237ac75d2adf60b7b316a11dcb5335aa803e4` | 4 | E4-complete | 通过 |
| v0.0.17 | `2702e5e905bec1b3749b3c1f1744ffe5f0d05df2` | 4 | E4-complete | 通过 |
| v0.0.18 | `528d720f929acd84ece7d6d7bf8f1c68e8557f1e` | 4 | E4-complete | 通过 |
| v0.0.19 | `9eb75212b4e1496ef7eaa43ac9e50de42a53cb17` | 4 | E4-complete | 通过 |
| v0.0.20 | `07fcac8528a9b9178e0ea3f90822e626d951c467` | 4 | E4-complete | 通过 |
| v0.0.21 | `8a7ba677a6fe5b4fc79dec474ccdb4206d09b823` | 4 | E4-complete | 通过 |

| 格式组 | 领域数 | 表数，含 metadata | 显式索引数 | Trigger 数 | ModelContextProjection.client |
|---|---:|---:|---:|---:|---|
| E3-detail | 87 | 89 | 165 | 2 | detail |
| E3-summary | 87 | 89 | 165 | 2 | summary |
| E4-complete | 91 | 93 | 174 | 2 | summary |

显式索引计数排除 `sqlite_%` 内部对象。以上三组是这些正式 tag 正常初始化写出的格式。当前另接受 90 领域、缺少 RuntimeDeliveryIntentLink 的 epoch 4 前驱，但 v0.0.15–v0.0.21 的正常新建库全部为 91 领域；不能把该额外兼容分支说成这些 tag 的正常格式。

### 格式摘要

以下 `RUNTIME_SCHEMA_DIGEST` 为对应 tag 的原始 schema 模块导出值，计算对象包含领域定义及 trigger；它不同于单个领域的 `schema_digest`，也不同于数据库文件的 SHA-256。

| 格式组 | RUNTIME_SCHEMA_DIGEST |
|---|---|
| E3-detail | `70cb7321464aa994abcd33faa971fe37cdb8c7a548dd7c5174167344094f7b87` |
| E3-summary | `6f646bd54e44040e346e467cb20ac4882441bb315491e3aad9aacc64a4e19507` |
| E4-complete | `f7d1afa5ea18cdc969e454331118eff3e70d8f93d5a8066b96339796e6aa478e` |

ModelContextProjection 的单领域摘要：

- detail：`4c587475862e73a9bf2c172e29d92c047e0e60a674630ce5b54e2e921f00c760`。
- summary：`f84996edbfcb6a9b62d9c42a5140cf279cf3d646e9a75872c52cbeb909c546a9`。

## 3. v0.0.12 标注错误的证据与影响

基线 [runtimeEpochMigration.ts](../backend/reliableKernel/runtimeEpochMigration.ts) 的 `PREVIOUS_RUNTIME_MANIFEST_VARIANT_CONTRACTS` 使用名称 `epoch-3-v0.0.10-v0.0.11` 和 `epoch-3-v0.0.12-v0.0.14`。但 v0.0.12 的 [domainsContext.ts](https://github.com/lurenxing628/limcode-test/blob/222c3f01de86e6ae53242392ce3882b7a2751d29/backend/reliableKernel/schema/domainsContext.ts) 仍写 `client: 'detail'`。

切换提交是 [d9f44fdf5848cd435c39cafe0a0e32c977a50f84](https://github.com/lurenxing628/limcode-test/commit/d9f44fdf5848cd435c39cafe0a0e32c977a50f84)，其 schema 改动只有 ModelContextProjection 的 `detail`→`summary`。`git tag --contains d9f44fdf` 最早包含 v0.0.13。两组物理 DDL 没变，manifest 和领域摘要改变。

`assertPublishedPreviousEpochManifest()` 对 epoch 3 逐个尝试两个完整变体；任意一个变体的所有行均匹配才接受。因此 v0.0.12 会通过 detail 变体，版本范围名称错误不会直接造成它被拒绝。本轮已将名称纠正为 `epoch-3-v0.0.10-v0.0.12` 和 `epoch-3-v0.0.13-v0.0.14`，同步文档与夹具说明，不改变被接受的 schema 集合；最终合同检查通过。

## 4. 检查方法及其边界

本轮检查没有用当前 schema 删表来生成旧库。具体步骤：

1. 对 v0.0.10–v0.0.21 分别使用 `git show <tag>:<path>` 读取其 `contracts.ts` 和 schema 模块。
2. 使用仓库已有 TypeScript 将模块在内存转译为 CommonJS，只运行 schema 定义和 SQL 生成器；没有启动旧扩展、Host 或任务恢复器。
3. 用各 tag 原始 `createRuntimeSchemaSql()` 创建独立 `SQLite :memory:` 数据库。
4. 用基线 `assertRuntimePhysicalSchemaFingerprint()` 核对完整非内部 table/index/trigger 集合及规范化后的 DDL；12 个全部通过。
5. 将旧 tag 原始 `RUNTIME_DOMAIN_SCHEMAS` 的每个领域对象与当前迁移明确接受的对应变体逐项比较，包括 columns、indexes、client、mutation、policy 等字段；全部匹配。
6. 通过 Git diff 确认 `databaseSchema.ts` 的 manifest 写入逻辑从 v0.0.10 到基线未变；旧对象的序列化和 `domainSchemaDigest()` 因而可对应真实 manifest 行。
7. 比较各 tag 与基线的 `createRuntimeRootPaths()` 输出；对同一测试 POSIX 路径均相同。`contracts.ts` 从 v0.0.10 到基线只有 epoch 常量发生改变。

以上证明已发布源码的正常初始化格式与当前历史合同相符，不代替包含真实历史内容的完整迁移演练。它未覆盖所有客户安装包 provenance、用户手工修改、磁盘损坏、未知开发版本或平台故障。

现有 [runtime-epoch-upgrade-preservation.test.mjs](../tests/reliable-kernel/runtime-epoch-upgrade-preservation.test.mjs) 的 `createPublishedRuntime()` 从当前格式创建库后删除新增领域、改回历史 manifest。它适合故障注入和迁移语义回归，但不能独立证明历史发布格式。此次从 tag 本身生成 DDL 的核对补上了这个证据缺口。

可复核的 Git 比较：

```bash
git diff v0.0.10 v0.0.14 -- backend/reliableKernel/schema
git diff v0.0.15 v0.0.21 -- backend/reliableKernel/schema
git diff v0.0.21 11ce63e195c667c78154e8560e598a1024f69b01 -- backend/reliableKernel/schema
git diff v0.0.10 11ce63e195c667c78154e8560e598a1024f69b01 -- backend/reliableKernel/databaseSchema.ts backend/reliableKernel/contracts.ts
git tag --contains d9f44fdf5848cd435c39cafe0a0e32c977a50f84
git tag --contains c1d9a737da08a58c64d0b5c88fa42286cd9a92ab
```

## 5. 已有原位迁移、根布局与路径限制

### 正式版本的迁移能力

[c1d9a737](https://github.com/lurenxing628/limcode-test/commit/c1d9a737da08a58c64d0b5c88fa42286cd9a92ab) 已进入正式 v0.0.24–v0.0.28。基线与 v0.0.24 的 `runtimeEpochMigration.ts`、`runtimePhysicalSchemaFingerprint.ts`、整个 schema 目录及 `contracts.ts` 没有差异。因此本轮验证的旧 schema 兼容性也适用于正式 v0.0.24。

该迁移在生产 Runtime 打开之前校验来源、要求其它 Host 离线、通过 SQLite Backup API 备份，再利用 pending pointer、事务与持久 journal 前进到 epoch 5。它还处理经过精确核验的旧 3→4 中断状态。未知结构不应通过放宽 fingerprint 猜测为某个旧版本。

`cff27207` 切换 epoch 5 后、`c1d9a737` 加入上述迁移之前，开发历史曾存在归档旧根后创建新库的路径。它可以作为开发构建来源的排查线索；正式 v0.0.24/.25 已包含后续修复，不能据此认定正式版自动清空历史。

### 物理布局

v0.0.10–v0.0.21 的源码已支持：

```text
<configurationRoot>/.limcode-runtime/active/
<configurationRoot>/.limcode-workspace-runtimes/scopes/<scope-key>/.limcode-runtime/active/
```

`2318ca99` 引入按工作区选择和 legacy-owner 分配；`5cf8d921` 改为对话宿主归属，但不改变上述 SQLite/CAS 位置。`d3f79edb` 引入固定数据集选择，旧 scope 仍保留在原位置。正常旧库不必搬到默认根才能升级。

### 位置及跨平台边界

RootBinding 的六个路径字段从 v0.0.10 到基线保持一致；数据库 `root_binding` 保存同样的绝对位置。基线 [rootAuthority.ts](../backend/reliableKernel/rootAuthority.ts) 的 `requireAbsolutePath()` 要求路径在当前平台为规范绝对路径；[vscodeRootAuthority.ts](../backend/reliableKernel/vscodeRootAuthority.ts) 又将候选位置与旧 pointer 逐字段比较；迁移核验数据库内路径必须与 pointer 相等。

因此，移动目录、从别处复制旧库、Windows 与 Linux 之间直接搬运旧指针，不属于现有原位迁移保证。隔离恢复应先认证来源身份和内容，再为目标建立新位置与绑定；不能仅改 JSON 指针或绕过数据库身份检查。

DDL 和 manifest 生成器没有平台分支，物理指纹会统一 SQL 空白；本轮未发现 Windows 专属 schema 变体。`5a3ddf7d` 已将 `toSqliteFilePath()` 引入旧库和备份的 SQLite I/O 边界，逻辑 RootBinding 路径继续保持普通规范形式。本轮实际执行环境为 Linux，Windows/macOS 的文件同步、路径及原生库行为仍需其平台验证。

## 6. 修复前入口缺陷与本轮自动升级

以下入口问题由本轮协作调查使用独立临时夹具确认，属于基线行为；修复后的验证结果见 §8。

| 问题 | 修复前行为与影响 | 本轮安排 |
|---|---|---|
| 维护锁失败留下空 scope | 全枚举将 scope 目录逐项交给严格候选检查，空 scope 的缺指针错误中断整个枚举，妨碍其它合法库的发现 | 修复空残留的候选识别；不把未知业务残留当作空库 |
| 归档后未初始化的新根只剩 backups | backups-only scope 同样被当作需要完整活动 RootBinding 的候选，导致全枚举失败 | 明确归档残留与活动候选边界，保留备份 |
| 未选中 epoch 3/4 无自动升级路径 | `RuntimeDataSetHistory.open()` 抛出 `runtime-history-offline-upgrade-required`；用户必须自行理解并切换现用库，才能走到已有启动升级 | 当前 Runtime 正常启动后自动批量升级其它旧库，读历史时自动补做；无升级按钮或确认 |

前两个问题解释了“一个不完整 scope 影响整个历史管理入口”的具体机制。第三个问题解释了“磁盘上还保留旧库，却不能通过只读历史直接打开”。这些证据支持修复入口，但不足以证明受影响客户一定经历了上述同一种路径。

本轮实现按以下行为验收：

1. `upgradeRuntimeDataSet` 严格复用已有精确 migrator，在来源的 admission/离线维护边界内先备份，再原位升级。旧 SQLite、manifest 和 RootBinding generation 会改变；原有 Conversation、Message、附件和 CAS 保留，历史 continuation 的精确转换可新增 CAS 内容。
2. 当前选中的 epoch 3/4 沿用已有 startup 自动升级；当前 Runtime 正常打开后，后台通过 `upgradeDiscoveredRuntimeDataSets` 串行升级发现的其它旧库。每个库单独收集失败，继续处理其它合法来源。
3. 查看旧历史时，入口自动补做仍需进行的升级，再打开只读历史。无需点击升级或确认。失败显示具体原因；已有备份保留，未知结构不自动改成空库。
4. 非当前旧库的升级不合并数据集、不改变当前选择、不注册其执行 Host，也不启动旧任务恢复。后台扫描应在配置根改变或宿主关闭后停止调度新来源。
5. 正常旧库的发现不再被坏 scope 整体阻断；当前数据集选择仍有歧义或选中来源本身异常时，保留既有显式选择处理，不自动 fallback 到其它库或新空库。

这次交付会修改来源格式，并保留升级前 SQLite 备份和原有 CAS；实施计划已据此更新。来源字节不变的隔离副本转换、任意归档/移位备份的重新绑定恢复和完整历史合并器，留待后续独立设计，不能宣称本轮已经完成。

## 7. 修复前测试基线

主线程本轮已在上述基线执行以下测试；编译产物 provenance 为 `commitSha=11ce63e195c667c78154e8560e598a1024f69b01`、`worktreeClean=true`，与基线源码匹配：

```bash
node --test --test-reporter=spec tests/reliable-kernel/runtime-epoch-upgrade-preservation.test.mjs tests/reliable-kernel/runtime-datasets.test.mjs tests/reliable-kernel/runtime-dataset-history-storage.test.mjs tests/reliable-kernel/runtime-dataset-commands.test.cjs
```

结果：**50 pass / 0 fail / 0 skipped，约 6.36 秒**。本轮临时日志位置：`/tmp/limcode-epoch3-4-baseline-tests.log`；该临时文件不属于归档证据集合，可能被系统清理。测试使用独立夹具，没有访问用户运行库。

该结果是修复前基线，不能证明新入口改动已通过。12 个 tag 的只读格式审计也不能代替新入口验收。

## 8. 本轮实现与最终本地验证

### 修改范围

- [vscodeRootAuthority.ts](../backend/reliableKernel/vscodeRootAuthority.ts)：新增逐库收集问题的发现入口。空 scope、仅有备份的 scope、损坏指针和普通文件不再阻断其它合法历史；没有合法来源时仍报错，不能自动创建空库代替。
- [runtimeDataSetUpgrade.ts](../backend/reliableKernel/runtimeDataSetUpgrade.ts)：新增单库和串行批量自动升级，复用原有精确迁移器。每库分别取得维护权限，验证身份、路径和目标库无运行宿主；保留备份与数据，拒绝未知格式及符号链接绕路，已知中断状态可继续。
- [extension.ts](../vscode/extension.ts) 与 [runtimeDataSetManagement.ts](../vscode/commands/runtimeDataSetManagement.ts)：主 Runtime 就绪后自动处理其它旧库；查看旧历史时自动补做。无升级按钮或确认，不改变当前选择、不启动非当前旧任务；失败按来源记录并提供原因。
- [runtimeDataSetUpgradeLifetime.ts](../vscode/runtimeDataSetUpgradeLifetime.ts)：统一跟踪后台升级和历史入口升级。关闭时停止接纳新升级，立即开始关闭当前 Runtime，并等待已经开始的升级收尾，避免升级拖延当前任务停止。
- 同步机器合同、合同校验、AGENTS 和架构文档。当前 Runtime epoch 仍为 **5**，没有新增 schema 或通用迁移链。

### 验证结果

环境：Linux，Node.js v24.19.0，SQLite 3.53.4。测试使用独立临时数据，没有操作客户实际数据库或附件。

| 检查 | 结果与边界 |
|---|---|
| `npm run check:plan` | 通过，包含编译、Webview 类型与合同检查；在最后的关闭流程和路径检查修正前执行 |
| 最终 `npm run compile` | 通过；560 个已编译来源的摘要与最终源码一致 |
| 最终 `npm run check:contracts:plan` | 通过 |
| 最终六文件定向回归 | **212 项：188 通过、0 失败、24 跳过、0 取消，约 15.04 秒**；跳过项为 Linux 上未执行的 Windows/macOS 专用测试 |

最终回归命令：

```bash
node --test --test-reporter=spec \
  tests/reliable-kernel/runtime-epoch-upgrade-preservation.test.mjs \
  tests/reliable-kernel/runtime-datasets.test.mjs \
  tests/reliable-kernel/runtime-dataset-history-storage.test.mjs \
  tests/reliable-kernel/runtime-dataset-commands.test.cjs \
  tests/reliable-kernel/platform-runtime-compatibility.test.mjs \
  tests/reliable-kernel/product-composition.test.mjs
```

归档输出：[最终定向回归日志](evidence/epoch3-4-recovery-final-tests.log)。这是一份新增证据，不修改原研究的摘要清单。

回归覆盖两个 epoch 3 manifest 变体、epoch 4、旧 3→4 中断状态和五个迁移中断位置；核对消息、附件与 CAS 保留、升级前备份、数据集身份、代际变化、重复执行、当前其它库可继续提交。覆盖异常来源隔离、目标存在运行宿主时拒绝升级、符号链接拒绝，以及已发布新指针后剩余 journal 的清理。

扩展入口测试执行转译后的真实扩展、启动类、历史命令与共享升级生命周期模块，并用 VM 替代 VS Code 环境。覆盖主 Runtime 先就绪、无升级确认、关闭时立即停止当前 Runtime 并等待已开始升级、无主 Runtime 时的历史升级收尾、关闭后不调度下一来源及不弹出过期界面。

### 本地验收时尚未验证或交付的范围

- 截至上述本地验收时点，尚未发布 VSIX；后续发布状态以 GitHub Release 为准。本次验收未通过真实 VS Code 双窗口 GUI 或 Windows/macOS 原生环境执行本轮完整流程；上述入口测试不能替代这些平台验证。
- 故障注入验证的是指定持久化位置的中断恢复，没有实施真实断电实验。
- 客户实际旧库、安装包来源、手工修改和磁盘损坏情况未知；不能保证未知数据都符合已验证的历史格式。
- 已经移动目录、跨平台搬运或只剩归档的来源仍需要单独的恢复与重新绑定设计；这次修复使此类来源的异常不再挡住其它合法旧库。

在未得到客户原始数据或其可验证恢复结果前，本轮只能报告已确认的历史兼容性、已复现的入口缺陷和本地夹具的修复结果，不能报告“客户全部历史已救回”。
