export type TaskStatus = 'running' | 'waiting_permission' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type Action = 'start' | 'continue' | 'cancel';
export type ToolName = 'computer_task' | 'list_tasks' | 'get_task' | 'take_screenshot';
export interface ComputerCommand { id: string; name: ToolName; action?: Action; taskId?: string; goal: string; context: string }
export interface TaskView { id: string; title: string; status: TaskStatus; detail: string; manual: boolean }
export interface Preferences {
  gpuUrl: string; gpuEnabled: boolean; dshBaseUrl: string; dshCwd: string;
  alwaysOnTop: boolean; micMuted: boolean; speakerMuted: boolean; inputDevice: string; outputDevice: string;
}
export interface SoulState { connected: boolean; cloud: string; video: string; subtitle: string; heard: string; tasks: TaskView[]; error?: string; configured: boolean; preferences: Preferences }
export type Media = { call: string; generation: number } & (
  { type: 'begin'; video: boolean } | { type: 'audio'; data: Uint8Array } | { type: 'frame'; index: number; data: Uint8Array } |
  { type: 'end' } | { type: 'interrupt' } | { type: 'fallback' });
export type Playback = { call: string; generation: number; samples: number; reason?: 'queue-overflow' | 'first-frame-timeout' | 'video-stall' | 'decode-error'; type: 'started' | 'progress' | 'ended' | 'fallback' | 'overflow' };
export interface SoulApi {
  memory(request: import('./memory').MemoryRequest): Promise<import('./memory').MemoryResult>;
  state(): Promise<SoulState>; start(): Promise<void>; stop(): Promise<void>; text(text: string): Promise<void>;
  cancel(taskId: string): Promise<void>; openDsh(): Promise<void>; importConfig(): Promise<void>;
  savePreferences(value: Preferences): Promise<void>; hide(): void; focusInput(): void;
  audio(data: ArrayBuffer, speaking: boolean): void; playback(event: Playback): void;
  onState(fn: (state: SoulState) => void): () => void; onMedia(fn: (media: Media) => void): () => void;
  onVisibility(fn: (visible: boolean) => void): () => void;
}
declare global { interface Window { soul: SoulApi } }
