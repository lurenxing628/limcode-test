<script setup lang="ts">
import AgentCollaborationSettings from '@webview/components/settings/agent/AgentCollaborationSettings.vue';
</script>

<template>
  <section class="global-settings-tab-section" aria-label="Agent 协作配置">
    <header class="global-settings-section-header">
      <div>
        <h2>Agent 协作</h2>
        <p>管理子 Agent 的分派层级和团队预算。深度默认保持 1，由你决定是否允许继续分派。</p>
      </div>
    </header>
    <AgentCollaborationSettings scope-kind="global" title="子 Agent 分派" />
  </section>
</template>
