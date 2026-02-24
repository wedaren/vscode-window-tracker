const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = process.env.TRACKER_DIR || path.join(os.homedir(), '.vscode-window-tracker');
const count = parseInt(process.argv[2] || '3', 10);

if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

function isoNow(offsetMinutes = 0) {
  return new Date(Date.now() - offsetMinutes * 60000).toISOString();
}

for (let i = 0; i < count; i++) {
  const pid = 20000 + Math.floor(Math.random() * 10000);
  const name = `proj-sim-${i+1}`;
  const rec = {
    title: name,
    path: path.join(process.cwd(), name),
    uri: `file://${path.join(process.cwd(), name)}`,
    pid,
    windowId: `sim-${pid}-${i}`,
    lastActive: isoNow(i * 5),
    source: 'sim',
    status: i % 2 === 0 ? 'visible' : 'idle'
  };
  const fname = `vscode-${rec.pid}-${Date.now()}-${i}.json`;
  fs.writeFileSync(path.join(dir, fname), JSON.stringify(rec, null, 2), { encoding: 'utf8' });
  console.log('wrote', path.join(dir, fname));
}

console.log(`generated ${count} tracker file(s) in ${dir}`);
