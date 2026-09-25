<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import SkillPolicyEditor from '@webview/components/settings/skills/SkillPolicyEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: skillLoading, text: skillLoadingText } = useSettingsLoadingText('技能配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="技能配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          技能
          <SettingsLoadingInline :show="skillLoading" :text="skillLoadingText" />
        </h2>
        <p>技能来自项目 .agents/、.claude/、.github/、.codex/ 下的 skills/，用户主目录 ~/.agents/、~/.claude/、~/.codex/、~/.copilot/ 下的 skills/，Claude Code 已安装的插件，以及数据根 skills/ 中的 SKILL.md（可按套件嵌套，支持软链接），SKILL.md 与插件清单变化后自动重新扫描；这里设置全局默认启用状态。对话、Agent 和工作流可以继承或覆盖，默认全部启用。</p>
      </div>
    </header>

    <SkillPolicyEditor
      scope-kind="global"
      title="全局默认技能策略"
      description="新对话或未单独设置技能的 Agent 和工作流会继承这里的启用状态。技能默认全部开启，可按项目或全局来源分组关闭。"
    />
  </section>
</template>
