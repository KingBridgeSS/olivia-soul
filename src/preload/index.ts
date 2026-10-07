import { contextBridge, ipcRenderer } from 'electron';
import type { SoulApi } from '../shared/types';
const api: SoulApi = {
  memory: request => ipcRenderer.invoke('soul:memory', request),
  state: () => ipcRenderer.invoke('soul:state'), start: () => ipcRenderer.invoke('soul:start'), stop: () => ipcRenderer.invoke('soul:stop'),
  text: text => ipcRenderer.invoke('soul:text', text), cancel: id => ipcRenderer.invoke('soul:cancel', id), openDsh: () => ipcRenderer.invoke('soul:dsh'),
  importConfig: () => ipcRenderer.invoke('soul:import'), savePreferences: value => ipcRenderer.invoke('soul:preferences', value),
  hide: () => ipcRenderer.send('soul:hide'), focusInput: () => ipcRenderer.send('soul:focus'),
  audio: (data, speaking) => ipcRenderer.send('soul:audio', data, speaking), playback: event => ipcRenderer.send('soul:playback', event),
  onState: fn => { const cb = (_: unknown, v: any) => fn(v); ipcRenderer.on('soul:state', cb); return () => ipcRenderer.removeListener('soul:state', cb); },
  onMedia: fn => { const cb = (_: unknown, v: any) => fn(v); ipcRenderer.on('soul:media', cb); return () => ipcRenderer.removeListener('soul:media', cb); },
  onVisibility: fn => { const cb = (_: unknown, visible: boolean) => fn(visible); ipcRenderer.on('soul:visibility', cb); return () => ipcRenderer.removeListener('soul:visibility', cb); }
};
contextBridge.exposeInMainWorld('soul', api);
