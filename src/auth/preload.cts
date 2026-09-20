import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('lms', {
  state: () => ipcRenderer.invoke('lms:state'),
  login: (profile: string, platform: string) => ipcRenderer.invoke('lms:login', profile, platform),
  onState: (callback: (state: unknown) => void) => { ipcRenderer.on('lms:update', (_e, state) => callback(state)); },
});
