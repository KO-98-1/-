// 데스크톱 창: 앱 서버(server.mjs)를 Electron 내장 Node로 띄우고 창에 연다. 창을 닫으면 서버도 끝낸다.
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const SMOKE = process.argv.includes('--smoke'); // 검수용: 화면을 저장하고 바로 종료
let server = null;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

function waitReady(url, tries = 100) {
  return new Promise((resolve, reject) => {
    const tick = (n) => http.get(`${url}api/settings`, (res) => { res.resume(); resolve(); }).on('error', () => (n > 0 ? setTimeout(() => tick(n - 1), 150) : reject(new Error('서버가 시작되지 않았습니다'))));
    tick(tries);
  });
}

async function start() {
  const port = await freePort();
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.mjs'), '--port', String(port)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit',
  });
  const url = `http://127.0.0.1:${port}/`;
  await waitReady(url);
  const win = new BrowserWindow({ width: 1280, height: 860, title: 'SW 표준 산출물 자동 작성', autoHideMenuBar: true, show: !SMOKE });
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  await win.loadURL(url);
  if (SMOKE) {
    await new Promise((r) => setTimeout(r, 800));
    const img = await win.webContents.capturePage();
    require('node:fs').writeFileSync(process.env.SMOKE_OUT || path.join(__dirname, 'smoke.png'), img.toPNG());
    app.quit();
  }
}

app.whenReady().then(start).catch((e) => { console.error(e); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('quit', () => { if (server) server.kill(); });
