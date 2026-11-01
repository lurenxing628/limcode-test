import type { TaskCompletionSoundSettingsRecord } from './protocol';

export const MAX_TASK_COMPLETION_AUDIO_BYTES = 2 * 1024 * 1024;

export function defaultTaskCompletionSoundSettings(): TaskCompletionSoundSettingsRecord {
  return { enabled: false, volume: 50, audioDataUrl: '', audioName: '' };
}

export function normalizeTaskCompletionSoundSettings(
  input?: Partial<TaskCompletionSoundSettingsRecord>
): TaskCompletionSoundSettingsRecord {
  const audioDataUrl = typeof input?.audioDataUrl === 'string' ? input.audioDataUrl : '';
  if (audioDataUrl && (!/^data:audio\/(?:mpeg|wav|x-wav|wave);base64,/.test(audioDataUrl)
    || audioDataUrl.length > Math.ceil(MAX_TASK_COMPLETION_AUDIO_BYTES / 3) * 4 + 64)) {
    throw new Error('提示音请选择不超过 2 MB 的 MP3 或 WAV 文件。');
  }
  return {
    enabled: input?.enabled === true,
    volume: typeof input?.volume === 'number' && Number.isFinite(input.volume)
      ? Math.min(100, Math.max(0, input.volume)) : 50,
    audioDataUrl,
    audioName: audioDataUrl && typeof input?.audioName === 'string' ? input.audioName : ''
  };
}
