# Runtime epoch 6 的已发布来源升级

## 已发布来源证据

Epoch 5 已公开发布，不能作为未发布格式原地补表。以下发布源码的 8 个输入文件与基线 `9b1f15124838344eaae9d49a977991daaa7e1ef1` 的 Git blob SHA 全部相同：`contracts.ts`、`schema/domainManifest.ts`、`schema/types.ts`、五个 `schema/domains*.ts`（Core、Execution、Context、Collaboration、CollaborationBoard）。它们决定 epoch、107 个领域、物理 DDL、manifest digest 与两条 trigger。

- [v0.0.29](https://github.com/lurenxing628/limcode-test/releases/tag/v0.0.29)：`e023a2286034b03bedb3bad07a8e94a438bb2f18`
- [v0.0.30](https://github.com/lurenxing628/limcode-test/releases/tag/v0.0.30)：`77bebe749598fd1d771b39beb2c1c1e896e91b6f`
- [v0.0.34](https://github.com/lurenxing628/limcode-test/releases/tag/v0.0.34)：`6a8874b830b78eb1451cd0b2e0f7afda34cdd18f`
- [v0.0.36](https://github.com/lurenxing628/limcode-test/releases/tag/v0.0.36)：`e804698866c5f139b09e23a1bb245ee353c37499`

`schema/publishedEpoch5.ts` 固定上述来源的完整描述，不从当前域数组推导 epoch 5。对 `{ domains, triggers, metadata }` 的 JSON SHA-256 为 `2dba9bcdb8341cd613808cb198f0fde920fe85316ee70a31c7158530b8e0fd3c`；普通域和 trigger 的原 schema SHA-256 为 `d50137fca19f104776c13105925fad7df50d7020108b91102124d756d38ebbba`。当前 epoch-6 保持原 107 个领域的全部表、列、既有索引定义和顺序；唯一具名例外是在 RuntimeDelivery 的原索引后追加 `(target_conversation_id,state,created_at,id)` 与 `(target_conversation_id,created_at,id)` 两个范围读取索引，由升级事务显式创建。模块严格比较这个精确的新定义，其余任何漂移均拒绝；已发布 epoch-5 描述始终不变。

## 唯一的新边界

当前 epoch 为 6，在原有 107 领域之后新增 RuntimeDeliveryTimelineLink、CollaborationSendTimelineLink 和 TimelineImportProvenance 三张独立 insert-only 关系表。升级先创建空表，仅按不可变 Context append 链身份、父节点关系与相邻物理 Message 成员证明历史输入的位置；不能证明的输入、历史发送及 notify-only 不写位置。绝不从 created_at、updated_at 或跨对象排序猜测旧消息的收发顺序。既有领域记录、CAS、附件和旧表/index/trigger 原地保留。

来源只接受：精确 epoch 3 的两个已发布 manifest、完整 epoch 4、严格缺 RuntimeDeliveryIntentLink 的已知 epoch-4 前驱、完整 epoch 5。其余缺表、DDL、manifest、RootBinding、完整性错误一律拒绝；不存在通用 migration fallback。未开始的 3/4 可以直接升级到 6，原 bounded Child continuation 转换仍只用于原来的两个适用前驱。

每份根在 maintenance 与离线 Host 栅栏内：完整只读核验 → pending fence → `epoch-to-6-migration.json` → SQLite Backup API 备份与摘要/身份核验、文件和目录持久同步 → synchronous=FULL 单事务新增领域、严格输入证据回填及更新 manifest/RootBinding → 验证完整目标及 checkpoint 成功 → epoch manifest/指针发布 → 外部完成记录。单次升级 rootGeneration 与 pointerRevision 同时加一，数据集和根实例身份不变。

当前输入接收由 writer 在同一事务里发布 Context/head、时间线关系和输入 ACK（PendingTurnInput consumed、RuntimeDeliveryInputLink handled_at）。事务核对模型投影读取的精确原始 content_object_id；删除通知先提交时，旧投影整体回滚后重新投影一次。已提交的输入不会在 Context 与 ACK 之间被改写。历史已有 Context 的幂等重放仍可 ACK，不以新的展示边界补造历史位置。删除子对话也检查对应的不可变 ContextSegmentSource，并在替换输入的事务内断言该 occurrence 尚不存在；旧版已经追加但尚未 ACK 的输入受到保护，包括不能证明时间线位置的末尾输入。

## 已发布中断边界

- `epoch-3-to-4-migration.json` 仍只能认证原来的 3→4，已提交与指针刚发布的窗口均收敛
- `epoch-to-5-migration.json` 仍只能认证原来的 3/4→5，不能改写成 epoch-6 journal
- 数据库尚未提交时，严格核验原根及已有备份，仅撤销原 fence/journal，再走当前升级
- 数据库已提交时，严格核验完整 epoch-5 结构、原绑定链和备份，完成原 epoch-5 指针与完成记录，然后从 epoch 5 独立备份升级到 6
- 原 epoch manifest 已发布而 pointer 未发布、pointer 已发布而 journal 未完成、已完成 journal 尚未删除，都保留严格恢复路径
- 两个目标 journal 同时存在、备份损坏/缺失、错代 pending 或未知物理结构不能通过

候选发现、只读 preflight、后台逐库升级、历史查看及合并来源使用同一已发布来源集合。外来拷贝仍不原地升级。备份清理保持原 3→4 永久保留规则；精确 3/4→5 与 3/4/5→6 完成记录继续受 7 天及完整覆盖证明约束，未完成的任一旧/新 journal 阻止清理。

## 验证入口

`tests/reliable-kernel/runtime-epoch-upgrade-preservation.test.mjs` 覆盖 3/4/5 正常保留、五个当前故障点、旧 3→4 与 3/4→5 各持久边界、epoch-5 全旧域记录与物理对象不变、空 timeline 关系，以及 DDL/manifest/backup/binding 漂移拒绝。实际运行须使用仓库构建后测试入口；仅源码检查不等于已运行测试。
