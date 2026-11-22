'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { spawn } = require('node:child_process');

async function main() {
  const repair = process.argv.includes('--repair');
  if (!repair && fs.existsSync(path.join(__dirname, '..', '.env.mysql.json'))) {
    console.log('Local MySQL configuration already exists. Run npm run start:local.');
    return;
  }
  if (!process.stdin.isTTY) {
    console.error('Run npm run setup:mysql in an interactive terminal.');
    process.exitCode = 1;
    return;
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    }
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const ask = prompt => new Promise((resolve, reject) => {
    const cancel = () => { rl.close(); reject(Object.assign(new Error(), { code: 'CANCELLED' })); };
    rl.once('SIGINT', cancel);
    rl.question(prompt, answer => { rl.removeListener('SIGINT', cancel); resolve(answer); });
  });
  let password;
  let user;
  try {
    console.log(repair ? 'Reconnect the game to local MySQL. Enter your CURRENT administrator password.' : 'Local MySQL setup. The administrator password will not be saved.');
    console.log('The administrator password will not be changed or saved.');
    user = (await ask('MySQL administrator username (Enter = root): ')).trim() || 'root';
    process.stdout.write('MySQL administrator password (hidden): ');
    muted = true;
    password = await ask('');
  } finally {
    muted = false;
    rl.close();
    process.stdout.write('\n');
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'setup-mysql.js'), ...(repair ? ['--repair'] : [])], {
    stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ user, password }));
  password = '';
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { process.exitCode = code ?? 1; resolve(); });
  });
}
main().catch(error => {
  console.error(error.code === 'CANCELLED' ? 'Setup cancelled.' : 'Unable to start MySQL setup.');
  process.exitCode = error.code === 'CANCELLED' ? 130 : 1;
});
