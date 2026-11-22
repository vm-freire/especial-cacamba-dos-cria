const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('estudio', {
  estado: inv('estado'),
  instalarMotor: inv('instalarMotor'),
  catalogo: inv('catalogo'),
  escolherArquivo: inv('escolherArquivo'),
  carregarModelo: inv('carregarModelo'),
  testar: inv('testar'),
  medianaF0: inv('medianaF0'),
  publicar: inv('publicar'),
  senha: inv('senha'),
  apagar: inv('apagar'),
  onProg: (cb) => ipcRenderer.on('prog', (_e, d) => cb(d)),
});
