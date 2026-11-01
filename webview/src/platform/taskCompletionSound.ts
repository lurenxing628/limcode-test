import type { TaskCompletionSoundSettingsRecord } from '@shared/protocol';
import builtInSound from '@webview/assets/task-complete.wav';

let audio: HTMLAudioElement | undefined;
let source: string | undefined;

/** One player per retained chat view; reuse the imported bytes and decoded media between tasks. */
export async function playTaskCompletionSound(settings: TaskCompletionSoundSettingsRecord): Promise<void> {
  audio ??= new Audio();
  audio.pause();
  const nextSource = settings.audioDataUrl || builtInSound;
  if (source !== nextSource) {
    audio.src = nextSource;
    source = nextSource;
  }
  audio.volume = Math.min(1, Math.max(0, Number(settings.volume) / 100 || 0));
  audio.currentTime = 0;
  await audio.play();
}

export function stopTaskCompletionSound(): void {
  audio?.pause();
}
