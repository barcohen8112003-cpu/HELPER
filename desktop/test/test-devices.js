const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'ui', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'ui', 'bubble.html'));

  const devices = await win.webContents.executeJavaScript(`
    navigator.mediaDevices.getUserMedia({ audio: true }).then(async (stream) => {
      const devs = await navigator.mediaDevices.enumerateDevices();
      stream.getTracks().forEach(t => t.stop());
      return devs.filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }));
    })
  `);

  console.log('[AUDIO DEVICES]:', JSON.stringify(devices, null, 2));

  setTimeout(() => app.quit(), 500);
});
