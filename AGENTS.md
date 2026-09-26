# AGENTS.md

本文件是 Limcode Test 项目后续开发时 AI Agent / 开发者需要遵守的架构准则。项目由 [lurenxing628](https://github.com/lurenxing628) 独立维护，仓库地址为 <https://github.com/lurenxing628/limcode-test>。重点是：**ECS 数据、协议、effect、存储都要保持领域对象解耦**。当前准则来自 Agent 与 Conversation 解耦改造经验。

当前生产入口是 `vscode/extension.ts → VscodeReliableKernelApplicationFacade → VscodeReliableKernelProductRuntime → ReliableKernelApplication`。Runtime 生命周期与提交权威由可靠内核和 SQLite worker 持有，Client Feed 直接投影已提交事实；`backend/world` 中仍复用部分领域类型、工具声明与 prompt helper，但旧 ECS World/System 循环不是生产执行器。下文 ECS 示例表达领域解耦准则，不得据此恢复旧运行 writer。

提交消息只写简明中文标题，不添加 `feat:`、`fix:` 等类型前缀，不使用晦涩说法，也不写正文。每个提交只表达一个完整改动。

## 1. 总原则

### 1.0 兼容原则

当前项目仍然处于开发模式，因此不要对旧格式有任何兜底，也不需要保留旧功能代码的兼容和体验，也不需要写什么协议v1，v2等之类的运行时内部版本号，全面使用新格式新功能更优秀的代码。

允许机器合同使用日期化`planRevision/contractRevision`、密码学domain separator或单一Runtime schema epoch来标识当前定义；这些标识不得用于运行时版本协商、旧格式fallback或维护未发布格式的通用 migration 链。当前 Runtime epoch 为 5。为保留已发布用户的对话，精确支持版本 0.0.10–0.0.14 的 epoch 3 和 0.0.15–0.0.21 的 epoch 4 离线升级到 epoch 5：数据库打开前核对完整 table/index/trigger/manifest/RootBinding 指纹，要求其它 Host 离线，使用 SQLite Backup API 持久备份，通过 pending pointer、单事务和 durable journal 向前恢复；旧版中断的 3→4 pending/journal 经精确核验后先收敛；原 Conversation、Message、附件与 CAS 保留。epoch 3 的旧 Child Runtime continuation、epoch 4 精确缺少 RuntimeDeliveryIntentLink 的前驱，仅在身份与内容全部严格匹配时转换。不允许由其它缺表、字段或 digest 推导前驱。未知结构漂移和不受支持的旧 epoch 保持原根不变并 fail closed，绝不自动换成空库；用户显式归档重置另走独立入口。当前 epoch 内任何 table/index/trigger/manifest/RootBinding 漂移也 fail closed，不补表、不修 metadata。

已发布 epoch 3/4 的备份升级自动执行，不要求用户点击单独升级命令或确认：当前根仍在 Runtime 打开前升级，其余旧根在当前 Runtime 就绪后逐库处理，查看旧历史时补做。每份目标必须离线并独立核验；其他正常数据集可继续使用。失败逐库报告，禁止隐式切换选择、合并数据集、启动非当前旧任务或把异常来源替换为空库。候选发现可分别返回可用项和错误，任何来源的实际打开/升级仍必须严格通过原有身份与指纹合同。

### 1.1 独立领域对象必须独立建模

如果两个概念可以独立存在、独立复用、独立存储，就不要把一个塞进另一个对象里。

当前项目中的典型例子：

```text
Agent 是独立对象
Conversation / Session 是独立对象
Message 是独立对象
AgentConversationLink 是独立关系对象
```

不要设计成：

```text
Agent owns Conversation
Conversation embeds Agent
SessionRecord.agentId 强制绑定 Agent
```

应该设计成：

```text
Agent Entity
  - Agent
  - AgentKind
  - ModelProfile
  - ToolPolicy
  - SystemPrompt
  - AgentStatus

Conversation / Session Entity
  - Session

Message Entity
  - Message
  - PartOf -> Conversation

Link Entity
  - AgentConversationLink { agent, conversation, role }
```

### 1.2 关系也必须是数据

两个领域对象之间的关系不能藏在对象内部，也不能写死在 system 逻辑里。关系本身应作为独立 ECS 数据存在。

例如：

```ts
AgentConversationLink {
  agent: Entity;
  conversation: Entity;
  role: 'active' | 'participant' | 'reviewer';
}
```

这样切换 agent、切换 conversation、多 agent 协作，本质上都是修改 link 数据。

## 2. ECS 开发准则

### 2.1 Component 表达单一事实

每个 component 应只表达一个清晰事实。推荐：

```text
Agent
ModelProfile
ToolPolicy
SystemPrompt
Session
Message
PartOf
AgentConversationLink
```

避免创建包含多个领域概念的大组件。

### 2.2 Link 优先于嵌套字段

当 A 与 B 的关系未来可能变化，或可能变成一对多 / 多对多时，必须优先使用 Link component/entity。

推荐：

```ts
AgentConversationLink { agent, conversation, role }
```

避免：

```ts
Session { id, agentId }
Agent { id, currentSessionId }
```

### 2.3 System 解释数据，不制造耦合

System 可以读取 link 并执行行为，但不能假设某个领域对象天然拥有另一个领域对象。

推荐流程：

```text
LlmDispatchSystem
  1. 找到 NeedsResponse 的 conversation
  2. 通过 AgentConversationLink 找 active agent
  3. 读取 agent 的 ModelProfile / SystemPrompt / ToolPolicy
  4. 读取 conversation 的 messages
  5. 发出 llm.start effect
```

避免：

```text
LlmDispatchSystem 假设 Session 一定 OwnedByAgent
```

## 3. Protocol / ClientState 准则

前端协议不能把后端已经拆开的对象重新耦合起来。

推荐：

```ts
interface ClientState {
  agents: AgentRecord[];
  sessions: SessionRecord[];
  agentConversationLinks: AgentConversationLinkRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}
```

避免：

```ts
interface SessionRecord {
  id: string;
  agentId: string;
}
```

如果新增独立对象，也应新增独立 patch：

```ts
{ kind: 'agentConversationLink.upsert'; link }
{ kind: 'agentConversationLink.remove'; id }
```

不要为了更新 link 而重发 agent 或 session。

### 3.1 Bridge / postMessage payload 必须是可结构化克隆的纯数据

Webview 与 Extension Host 之间通过 `postMessage` 传递数据，payload 必须满足浏览器 structured clone 规则。**不要把 Vue / Pinia 的响应式对象、Proxy、ref、computed、DOM Event、函数、class 实例、Map / Set 等直接放进 bridge payload**，否则容易触发：

```text
DataCloneError: Failed to execute 'postMessage' on 'MessagePort': [object Object] could not be cloned.
```

强制要求：

```text
1. 调用 bridge.request / bridge.post / vscode.postMessage 前，必须把 payload 转成普通 Object / Array / string / number / boolean / null。
2. 不要直接传 Pinia state，例如 settings: this.llm、payload: store.xxx、items: reactiveArray。
3. 对嵌套对象也要递归转成纯对象；数组用 map 重新生成，record 用 Object.fromEntries / 显式 for 循环重新生成。
4. 优先使用已有 normalize / sanitize / toPlainXxx 函数；没有就新增一个专用转换函数，不要偷懒直接传响应式对象。
5. 发送前的协议对象应只包含 shared/protocol.ts 里定义的字段，不要把 UI 临时字段、组件对象、事件对象混进去。
```

推荐：

```ts
const settings = normalizeLlmSettings(this.llm);
bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
  section: 'llm',
  settings
});
```

避免：

```ts
bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
  section: 'llm',
  settings: this.llm // Pinia state / Proxy，禁止直接发送
});
```

如果 payload 来自 store，最低限度也要显式构造：

```ts
const payload = {
  conversationId: this.llm.conversationId,
  activeProviderConfigId: this.llm.activeProviderConfigId,
  ...(plainModelOverrides ? { modelOverrides: plainModelOverrides } : {})
};
```

排查准则：只要遇到 `DataCloneError`，第一时间检查最近一次 `bridge.request(...)` 是否传入了 Pinia/Vue Proxy 或不可 clone 对象。

## 4. Effect 层准则

### 4.1 Effect payload 不应长期携带领域耦合结构

Effect 是 system 到 runtime capability 的边界。这个边界也必须保持解耦。

推荐：

```text
llm.start effect 接收：
  - model settings
  - prompt messages
  - tools
```

这些数据可以由 system 根据 ECS link 临时组装，但 effect 不应该保存类似 `agentWithConversation` 的耦合结构。

### 4.2 Effect handler 只执行外部能力

Effect handler 不应承载领域关系规则。领域关系应在 ECS world 中由 component/link 表达，由 system 解释。

例如：

```text
LlmDispatchSystem 决定哪个 agent 使用哪个 conversation
LLM capability 只负责调用模型
Storage capability 只负责读写当前投影数据
```

## 5. Storage 层准则

### 5.1 文件层也必须解耦

如果 ECS 和协议层已经拆成独立对象，存储层不能再把它们塞回一个大JSON记录或一个表达领域ownership的强绑定目录。

可靠运行内核可以让多个Runtime领域表物理共用一个SQLite文件，但这只是共同事务介质，不表示领域ownership。强制要求：每个领域对象/Link具有独立table、schema owner、Repository、codec、mutation mapping、Client mapping、delete/reset/index policy；禁止generic family JSON表、任意SQL batch和跨领域聚合记录。Agent/Workflow/Policy/Settings等配置authority仍使用独立settings roots，不迁入Runtime SQLite。该例外必须由`docs/architecture/reliable-kernel/contracts/authority.json`逐项machine crosswalk约束。

推荐结构：

```text
<dataRoot>/
  agents/
    index.json
    records/{timeSlugHash}.json

  conversations/
    index.json
    {timeSlugHash}/
      conversation.json
      messages/
        index.json
        chunks/000000.json

  agent-conversation-links/
    index.json
    records/{timeSlugHash}.json
```

含义：

```text
agents/ 只保存 agent 数据
conversations/ 只保存 conversation 与 message 数据
agent-conversation-links/ 只保存 agent 与 conversation 的关系
```

避免：

```text
chat/manifest.json 同时保存 agents、sessions、links
conversation 文件夹里保存 agent 配置
agent 文件夹里保存 conversation 历史
```

### 5.2 Index 只描述本类对象

每类数据的 index 只索引本类对象：

```text
agents/index.json 只列 agent records
conversations/index.json 只列 conversation records
agent-conversation-links/index.json 只列 link records
```

不要跨领域混存。

### 5.3 文件名必须可读、可排序、稳定

新记录文件名使用：

```text
{yyyyMMdd-HHmmss-SSS}-{可读slug}-{短hash}
```

例如：

```text
20260530-142233-123-main-0ab12cd.json
20260530-142240-456-default-1x9k2p3/
```

规则：

```text
1. 新记录生成 time + slug + hash 名称
2. 已存在记录复用 index 中的 file/folder
3. 未发布阶段不写旧格式兼容或迁移代码
```

### 5.4 数据文件路径必须通过 getPaths 获取

当需要读写/创建任何业务数据文件或目录时，必须先通过当前 storage capability 内部的 `getPaths()` 获取路径：

```ts
function getPaths(): StoragePaths {
  currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));
  return currentPaths;
}
```

要求：

```text
1. 业务数据文件必须写到 getPaths() 返回的对应 root/index 路径下，例如 agentsRootUri、conversationsRootUri、linksRootUri、settingsRootUri 等。
2. 普通文件配置/业务store每次load/save/ensure storage roots前都应重新调用getPaths()，不要长期缓存旧路径。
3. SQLite长连接只允许缓存由RootAuthority通过getPaths建立的immutable、fenced `RootBinding { paths, dataSetId, rootInstanceId, rootGeneration, pointerRevision, runtimeKernelEpoch }`；禁止缓存裸路径。每个request/transaction必须重验binding generation，root switch通过新binding reopen。
4. CAS和配置operation每次从RootAuthority获取current binding/operation registration；不能由各模块自行读取Memento重新选root。
5. 不要直接使用VS Code extension context的globalStorageUri/globalStoragePath/globalState拼接业务数据路径。
6. globalStatus只用于保存数据根目录配置、当前激活数据目录与迁移控制元数据，不用于承载业务数据文件或proxy等业务设置；业务设置进入`GLOBAL_SETTINGS_SECTIONS`对应settings root。
```

原因：

```text
通过 resolveDataRootUri(context) + createVscodeStoragePaths(...) 统一生成路径，才能集中控制数据目录，支持后续数据文件迁移、切换和管理。
```

## 5.5. UI设计原则

避免蓝紫色+大圆角。按钮 hover / focus / active / 选中态也尽量不要使用 VS Code 默认的蓝色实心背景；如需高亮，优先使用中性灰色背景或轻量边框，避免蓝色块破坏整体风格。

如果前端需要使用滚动条，优先使用自定义滚动条组件，不要直接依赖浏览器默认滚动条：

```text
webview/src/components/navigation/AdvancedScrollbar.vue
```

要求：

```text
1. 普通内容区域需要滚动条时，使用 AdvancedScrollbar。
2. 下拉面板、浮层、小区域滚动条优先使用 AdvancedScrollbar 的基础样式 variant="minimal"：无可见导轨，仅悬浮显示滑块，不占用布局空间。
3. 如确实不能使用 AdvancedScrollbar，需说明原因，并保持视觉风格与现有自定义滚动条一致。
```

如果前端需要做信息展示类悬浮面板（例如 token / usage / 指标明细、图表柱子明细、状态解释等 hover/focus 提示），必须优先复用：

```text
webview/src/components/ui/HoverTooltipPanel.vue
```

要求：不要直接依赖浏览器默认 `title` 提示，也不要临时写新的 tooltip / hover 面板；复用 `HoverTooltipPanel` 的展示样式、进入 / 离开动画、延迟和关闭等待时间。只有在交互形态明显不是信息展示 tooltip 时，才允许使用下拉面板或其他浮层组件，并说明原因。


### 5.6 设置页组件使用标准

设置页内的通用交互组件必须保持一致：

```text
1. 下拉选择不要直接使用浏览器原生 select；优先复用 webview/src/components/settings/global/SettingsDropdown.vue。该组件基于 project-dropdown + lc-dropdown-panel + IconCaretUp。
2. 下拉按钮右侧使用 IconCaretUp，并用旋转动画表达展开 / 收起。
3. 下拉面板内容可能超过高度时，必须复用 webview/src/components/navigation/AdvancedScrollbar.vue；最基础样式使用 variant="minimal"，无可见导轨，仅显示滑块。SettingsDropdown 已内置该规则，并支持 maxHeight / height 以适配最大高度或固定高度场景。
4. 需要删除、危险操作或二次确认时，必须复用 webview/src/components/ui/ConfirmPanel.vue，不要临时写新的确认弹窗。
5. 需要输入名称、重命名等简单文本输入弹窗时，优先复用 webview/src/components/ui/InputPanel.vue。
6. 需要勾选框 / 复选框 / 列表选中标记时，必须复用 webview/src/components/ui/LcCheckbox.vue；不要临时使用原生 checkbox 默认样式，也不要用 span + “✓” 拼接勾选图形。纯展示选中标记使用 presentation 模式，交互式复选框使用 v-model / update:model-value。
7. 设置页签内容较多时按页签拆分 Vue 组件，主面板只负责布局与页签切换。
8. 需要 token 数阈值 / 上下文窗口阈值滑条时，优先复用 webview/src/components/ui/TokenThresholdSlider.vue；不要在业务组件中临时编写 range 滑条样式。该组件已内置 1k 对齐、顶部 token 标签、底部百分比标签、推荐阈值标签与中性灰视觉风格。
```

`TokenThresholdSlider` 基础用法：

```vue
<TokenThresholdSlider
  :model-value="thresholdTokens"
  :max-tokens="contextWindowTokens"
  :step-tokens="1000"
  :recommended-tokens="contextWindowTokens - 20000"
  label-variant="tag"
  :show-top-label="true"
  :show-bottom-label="true"
  aria-label="拖拽调整自动压缩触发阈值"
  @update:model-value="updateThresholdTokens"
/>
```

要求：业务组件只负责计算 `model-value`、`max-tokens`、`recommended-tokens` 并在 `update:model-value` 中写回配置；滑条的 token / 百分比展示、推荐标签、hover / focus 样式由组件统一维护。如需标签样式，使用 `label-variant="tag"`；如需隐藏上下数字，使用 `:show-top-label="false"` / `:show-bottom-label="false"`；如需隐藏推荐标签，使用 `:show-recommended-tag="false"`。

### 5.7 配置项数据对接标准

新增任何设置项 / 配置页 / 可复用配置记录前，必须先阅读（该文为 settings 子系统长期规范，可靠内核切换后继续有效）：

```text
docs/global-settings-data-integration.md
```

开发时必须先区分两个 scope：

```text
1. 配置管理 scope：这个配置入口属于 global / conversation / agent 哪一级设置。
2. 配置数据 scope：这个配置是简单 section，还是该 settings scope 下的可复用 record 集合，还是独立 ECS 领域对象。
```

要求：

```text
1. 如果入口属于全局设置，优先新增 GLOBAL_SETTINGS_SECTIONS section，并复用 settings.global.get/update/snapshot。
2. 不要为了全局设置页里的 CRUD 新建独立 BridgeMessageType / Bridge / 顶层 storage root。
3. 如果全局设置下有多个可复用配置页，每个配置仍可作为独立 record 存在，但应放在 settingsRootUri 对应 section 下，通过 index + records 管理。
4. 当前激活 id / 默认选择这类状态应单独作为 settings section 保存，不要塞进每个配置 record。
5. 如果某配置未来要被 Agent / Workflow / Conversation 复用，应通过 Link/关系数据引用配置 id，不要把配置对象嵌入主体对象。
```

## 6. 默认初始化准则

默认初始化可以为了跑通基础体验创建默认对象，但也必须遵循解耦模型。

推荐：

```text
创建 default Agent
创建 default Conversation
创建 AgentConversationLink(default Agent, default Conversation, active)
```

避免：

```text
创建 Agent 时把 Conversation 内嵌进去
创建 Session 时必须写 agentId
```

## 7. 新功能设计检查清单

新增模块、组件、effect、协议或存储格式前，必须检查：

```text
1. 这个字段是不是其实在表达另一个领域对象？
2. 这个关系未来是否可能一对多或多对多？
3. 切换关系是否能只改 link，而不用改主体对象？
4. ClientState 是否把独立对象重新塞进另一个对象？
5. Effect payload 是否携带了长期领域关系？
6. 是否把多个领域对象塞进同一大 JSON / 聚合记录，或在共用 SQLite 时遗漏独立 table、Repository、Link/FK 与 mutation mapping？
7. 是否为了未发布的旧格式写了兼容/迁移代码？如果没有发布，应该删除。
8. 数据文件路径是否通过 getPaths() 获取，或由 RootAuthority 建立并逐事务校验 fenced RootBinding，而不是直接使用 extension globalStorage/globalState/globalStatus？
9. 新增配置项前是否已阅读 docs/global-settings-data-integration.md（settings 子系统长期规范），并区分配置管理 scope 与配置数据 scope？
```

如果发现耦合，优先拆成：

```text
主体对象 A
主体对象 B
Link / Relation 对象
System 解释 Link
Effect 执行外部能力
Storage 按领域分目录，或在共用 SQLite 中按领域独立表与 Repository 持久化
```

## 8. 当前 Agent / Conversation 案例

当前生产结构：

```text
Configuration:
  Agent / ModelProfile / Policy 位于独立配置 roots

Runtime domains:
  Conversation 独立
  Message / MessageRevision 与 Conversation 的关系独立
  AgentConversationLink 独立表达 Agent 与 Conversation 的关系
  Turn / EffectIntent / EffectReceipt 独立表达执行与外部结果

Protocol:
  ConfigurationSnapshot 投影配置
  有界 Runtime snapshot / changes 投影已提交运行事实
  对话设置按 conversationId 分发，不能覆盖其他面板的作用域

Storage:
  独立配置 roots 保存 Agent、Workflow、Policy、Settings
  Runtime SQLite 按领域保存 Conversation、Message、Turn 与各类 Link
  CAS 保存正文和大结果

Execution:
  CommandRouter / Facade 接收命令
  可靠内核 control planes 解释独立领域与 Link 并提交事实
  capability adapters 执行外部能力
  Client Feed 直接投影已提交事实到 Webview
```

这套方式后续应用于所有类似模块：只要两个概念可以被不同功能复用，就不要做所有权绑定，而是通过独立 link 和 system 组合。
