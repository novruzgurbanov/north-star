const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('northStarCapture', {
  onCommand: (listener) => {
    if (typeof listener !== 'function') return;
    ipcRenderer.on('capture:command', (_event, command) => listener(command));
  },
  reply: (reply) => ipcRenderer.send('capture:reply', reply),
});
