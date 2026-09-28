<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import DebugCaptureSettings from './DebugCaptureSettings.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';
import { EXTENSION_USER_AGENT } from '@shared/extensionIdentity';

const settings = useGlobalSettingsStore();
const { loading: otherLoading, text: otherLoadingText } = useSettingsLoadingText('其他设置', 'global', undefined, { globalSettingsSections: ['common', 'network', 'attachments'] as const });

function inputNumber(event: Event): number {
  const target = event.target as HTMLInputElement | null;
  return Number(target?.value ?? 20);
}

function saveOtherSettings(): void {
  settings.saveCommon();
  settings.saveNetwork();
}
</script>

<template>
  <section class="global-settings-tab-section" aria-label="其他全局设置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          其他
          <SettingsLoadingInline :show="otherLoading" :text="otherLoadingText" />
        </h2>
        <p>除渠道外，其余全局配置暂时统一放在这里。</p>
      </div>
    </header>

    <label class="global-settings-field">
      <span>网络代理地址（留空则直连；可省略 http://，例如 127.0.0.1:7897）</span>
      <input v-model="settings.common.proxy" type="text" placeholder="127.0.0.1:7897 或 http://127.0.0.1:7897" />
    </label>

    <label class="global-settings-field">
      <span>默认 User-Agent（UA）</span>
      <input
        v-model="settings.network.userAgent"
        type="text"
        spellcheck="false"
        autocomplete="off"
        aria-label="默认 User-Agent"
        :placeholder="EXTENSION_USER_AGENT"
      />
      <span class="global-settings-field-hint">统一用于 LLM 的 HTTP 请求与 WebSocket 握手；渠道或 LLM 专属配置中的 User-Agent 请求头可覆盖。留空使用 {{ EXTENSION_USER_AGENT }}，不模拟 TLS 指纹或完整客户端环境。</span>
    </label>

    <div class="global-settings-field">
      <span>代理覆盖范围</span>
      <LcCheckbox
        :model-value="settings.common.proxyShellAndMcp"
        size="sm"
        aria-label="让 shell 工具与 MCP 连接使用代理"
        @update:model-value="settings.common.proxyShellAndMcp = $event"
      >
        <span class="global-settings-checkbox-label">同时覆盖 shell 工具与 MCP 连接</span>
      </LcCheckbox>
      <span class="global-settings-field-hint">默认关闭，仅 LLM 提供商连接使用代理；勾选后新启动的 shell 子进程继承代理环境变量，MCP 连接保存后自动重建。</span>
    </div>

    <div class="global-settings-field" aria-label="数据目录">
      <span>数据目录</span>
      <p class="global-settings-path">
        当前数据目录：<code>{{ settings.common.activeDataRootPath || '正在获取当前数据目录…' }}</code>
      </p>
      <p v-if="settings.common.previousDataRootPath" class="global-settings-path">
        迁移前的旧目录：<code>{{ settings.common.previousDataRootPath }}</code>
      </p>
      <div v-if="settings.common.relocationLeftBehind?.length" class="global-settings-path">
        <span>以下历史库上次迁移时没有带过来，仍在旧目录：</span>
        <ul>
          <li v-for="line in settings.common.relocationLeftBehind" :key="line"><code>{{ line }}</code></li>
        </ul>
      </div>
      <div class="global-settings-actions">
        <button type="button" class="secondary" @click="settings.requestDataRootAction('relocate')">迁移数据目录…</button>
        <template v-if="settings.common.previousDataRootPath">
          <button type="button" class="secondary" @click="settings.requestDataRootAction('returnToPrevious')">回到旧目录…</button>
          <button type="button" class="secondary" @click="settings.requestDataRootAction('deletePrevious')">删除旧目录…</button>
        </template>
        <button type="button" class="secondary" @click="settings.requestDataRootAction('cleanupBackups')">清理备份…</button>
      </div>
      <span class="global-settings-field-hint">迁移时先检查新目录（空间、权限、是否云同步目录、数据量），确认后把当前历史库、其它历史库、设置、全局规则和技能复制到新目录并逐项核对，旧目录里的历史与设置不被改动（只在那里留下一个“数据已迁走”标记；选了“先把上一次迁走的任务按中止收尾”时会先在旧目录收尾）；所有 LimCode 窗口会重载一次，有任务的窗口会等任务结束，未发送的输入会保留。删除旧目录只删除确认迁移过去、且迁移之后没有改动的内容，删除前完整列出并再次确认，备份和归档默认保留。清理备份只删除能证明内容已完整在本地库里的副本：升级前、合并前与合并来源的收尾前备份，以及核验通过的外来历史库（“归档并重置”的归档、以前的数据目录里的归档和拷来目录里的库）。副本里的每个对话、消息版本和工具调用、输出、回答等记录都要还在当前库或同一数据目录的某个历史库里，正文文件也在，副本里显示的每条消息在那里也显示同一个版本；含有别处没有的对话或记录的一律保留。内容完整的默认勾选；有消息在那里已被你删除、编辑或重试替换的单独列出，默认不勾选。拷来目录本身和其中的设置、规则、技能不会被删除。删除前分两步确认，并在锁内再核对一遍。</span>
    </div>

    <label class="global-settings-field">
      <span>单条消息附件总大小上限（MB，默认 20；不限制附件数量）</span>
      <input :value="settings.attachments.maxStoredInlineFileMb" type="number" min="1" max="200" step="1" @change="settings.setAttachmentSettings({ maxStoredInlineFileMb: inputNumber($event) })" />
    </label>

    <div class="global-settings-actions">
      <button type="button" @click="saveOtherSettings">保存其他设置</button>
      <button type="button" class="secondary" @click="settings.requestAll()">重新读取</button>
      <span class="global-settings-status">{{ settings.status }}</span>
    </div>

    <div class="global-settings-path-list" aria-label="全局设置路径信息">
      <p class="global-settings-path">
        默认数据目录：<code>{{ settings.common.defaultDataRootPath || '正在获取默认数据目录…' }}</code>
      </p>
      <p class="global-settings-path">
        路径配置保存位置：<code>{{ settings.filePaths.common || '正在获取 VS Code 配置存储位置…' }}</code>
      </p>
      <p class="global-settings-path">
        网络设置：<code>{{ settings.filePaths.network || '正在获取网络设置路径…' }}</code>
      </p>
      <p class="global-settings-path">
        当前渠道选择：<code>{{ settings.filePaths.llm || '正在获取当前渠道配置路径…' }}</code>
      </p>
      <p class="global-settings-path">
        渠道配置页：<code>{{ settings.filePaths.llmProviderConfigs || '正在获取模型渠道配置路径…' }}</code>
      </p>
    </div>
    <DebugCaptureSettings />
  </section>
</template>
