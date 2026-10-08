import * as vscode from 'vscode';

type SettlementCounts = { candidateId: string; turns: number; intents: number; deliveries?: number; children?: number; effects?: number };

export async function confirmRuntimeHistorySettlement(
  input: SettlementCounts & { sources?: SettlementCounts[] },
  stillCurrent: () => boolean
): Promise<boolean> {
  if (!stillCurrent()) return false;
  const details = (input.sources ?? [input]).map(source => `${source.candidateId}：${source.turns} 个进行中的轮次，${source.intents} 条排队消息，${source.deliveries ?? 0} 条待投递消息，${source.children ?? 0} 个子 Agent，${source.effects ?? 0} 个已派发效果。`).join('\n');
  const answer = await vscode.window.showWarningMessage('中止旧数据中的工作后合并？', {
    modal: true,
    detail: `${details}\n原库先备份；中止后的工作不会继续执行。已派发但无法确认结果的效果会记为结果未知。`
  }, '同意收尾并合并');
  return answer === '同意收尾并合并' && stillCurrent();
}
