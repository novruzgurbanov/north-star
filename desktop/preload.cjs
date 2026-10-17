const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('northStarDesktop', {
  isDesktop: true,
  platform: process.platform,
  focus: {
    start: (options) => ipcRenderer.invoke('focus:start', options),
    pause: () => ipcRenderer.invoke('focus:pause'),
    resume: () => ipcRenderer.invoke('focus:resume'),
    stop: () => ipcRenderer.invoke('focus:stop'),
    setCamera: (enabled) => ipcRenderer.invoke('focus:set-camera', enabled),
    getState: () => ipcRenderer.invoke('focus:get-state'),
    onState: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const handler = (_event, state) => listener(state);
      ipcRenderer.on('focus:state', handler);
      return () => ipcRenderer.removeListener('focus:state', handler);
    },
  },
});
