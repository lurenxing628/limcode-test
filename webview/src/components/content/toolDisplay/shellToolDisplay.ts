import { IconTerminal2 } from '@tabler/icons-vue';
import { parseShellArgs, shellInputSections, shellOutputSections } from './shellToolModel';
import { fileChangeDiffFromResult } from './fileChangeToolDisplay';
import type { ToolDisplayResolver } from './types';

export const shellToolDisplay: ToolDisplayResolver = (context) => {
  const diff = fileChangeDiffFromResult(context.result) ?? fileChangeDiffFromResult(context.progress);
  const outputSections = shellOutputSections(context);
  const isMetadata = (section: (typeof outputSections)[number]) => section.title === '操作说明'
    || section.title === '执行信息' || Boolean(diff && section.title === '输出');
  return {
    headerIcon: IconTerminal2,
    inputSections: [],
    detailSections: [
      ...shellInputSections(parseShellArgs(context.args), context),
      ...outputSections.filter(isMetadata)
    ],
    outputSections: [
      ...(diff ? [{ kind: 'output' as const, title: '文件变化', diff }] : []),
      ...outputSections.filter(section => !isMetadata(section))
    ]
  };
};
