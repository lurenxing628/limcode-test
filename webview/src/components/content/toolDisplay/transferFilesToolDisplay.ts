import { IconTransfer } from '@tabler/icons-vue';
import type { ToolDisplayResolver, ToolDisplaySection } from './types';

export const transferFilesToolDisplay: ToolDisplayResolver = (context) => {
  const args = asRecord(context.args);
  const transfers = Array.isArray(args?.transfers) ? args.transfers.map(asRecord).filter(Boolean) : [];
  const transferLines = transfers.map((transfer, index) => {
    const from = endpoint(transfer?.fromEnvironment, transfer?.fromPath);
    const to = endpoint(transfer?.toEnvironment, transfer?.toPath);
    return `${index + 1}. ${from} → ${to}`;
  });
  const inputSections: ToolDisplaySection[] = transferLines.length > 0
    ? [{ kind: 'input', title: '传输项目', text: transferLines.join('\n') }]
    : [];

  const outputSections = transferOutputSections(context.result);

  return {
    headerIcon: IconTransfer,
    inputSections,
    ...(outputSections ? { outputSections } : {})
  };
};

function endpoint(environment: unknown, path: unknown): string {
  const environmentText = text(environment);
  const displayEnvironment = !environmentText
    ? '工作环境'
    : environmentText.startsWith('work-env-') ? '工作环境' : environmentText;
  return `${displayEnvironment}:${text(path) ?? '?'}`;
}

function transferOutputSections(value: unknown): ToolDisplaySection[] | undefined {
  const record = asRecord(value);
  const detail = asRecord(record?.detail) ?? record;
  const observations = Array.isArray(detail?.operations)
    ? detail.operations.map((value) => {
        const operation = asRecord(value);
        return { status: text(operation?.status), detail: asRecord(operation?.detail) };
      })
    : [{ status: text(detail?.status) ?? text(record?.status), detail }];
  const sections: ToolDisplaySection[] = [];

  for (const observation of observations) {
    const result = asRecord(observation.detail?.result) ?? observation.detail;
    const output = asRecord(result?.output);
    const summaryRows = [
      row('结果', successText(result?.ok) ?? outcomeText(observation.detail?.outcome ?? observation.status)),
      row('总数', numberText(output?.totalCount)),
      row('成功', numberText(output?.successCount)),
      row('失败', numberText(output?.failCount)),
      row('说明', text(result?.output) ?? text(result?.reason) ?? text(result?.message) ?? text(result?.error)
        ?? text(observation.detail?.reason) ?? text(observation.detail?.error))
    ].filter(isRow);
    if (summaryRows.length > 0) {
      sections.push({ kind: 'output', title: '传输结果', rows: summaryRows, rowStyle: 'keyValue' });
    }

    const entries = Array.isArray(output?.results) ? output.results : [];
    entries.forEach((value, index) => {
      const entry = asRecord(value);
      const from = asRecord(entry?.from);
      const to = asRecord(entry?.to);
      const verify = asRecord(entry?.verify);
      const rows = [
        row('结果', successText(entry?.success)),
        row('来源', from ? endpoint(from.environment, from.path) : undefined),
        row('目标', to ? endpoint(to.environment, to.path) : undefined),
        row('文件数', numberText(entry?.files)),
        row('目录数', numberText(entry?.dirs)),
        row('大小', numberText(entry?.bytes) !== undefined ? `${numberText(entry?.bytes)} 字节` : undefined),
        row('验证', verificationText(verify)),
        row('错误', text(entry?.error))
      ].filter(isRow);
      if (rows.length > 0) {
        sections.push({ kind: 'output', title: `第 ${index + 1} 项传输`, rows, rowStyle: 'keyValue' });
      }
    });
  }
  return sections.length > 0 ? sections : undefined;
}

function successText(value: unknown): string | undefined {
  return typeof value === 'boolean' ? value ? '成功' : '失败' : undefined;
}

function verificationText(value: Record<string, unknown> | undefined): string | undefined {
  if (value?.mode === 'none') return '未校验';
  if (value?.mode !== 'size' || typeof value.ok !== 'boolean') return undefined;
  return value.ok ? '大小一致' : '大小不一致';
}

function outcomeText(value: unknown): string | undefined {
  const outcome = text(value);
  if (!outcome) return undefined;
  return ({
    succeeded: '成功',
    failed: '失败',
    outcome_unknown: '结果未知',
    rejected: '已拒绝',
    cancelled: '已取消'
  } as Record<string, string>)[outcome] ?? outcome;
}

function isRow(value: { label: string; value: string } | undefined): value is { label: string; value: string } {
  return value !== undefined;
}

function row(label: string, value: string | undefined): { label: string; value: string } | undefined {
  return value ? { label, value } : undefined;
}

function numberText(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
