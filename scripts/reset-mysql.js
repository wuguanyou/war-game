'use strict';
// Run by the owner in an elevated terminal. Never disables MySQL authentication.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const serviceName = 'MySQL2610';
const mysqlBin = 'C:/Program Files/MySQL/MySQL Server 26.10/bin/mysqld.exe';
const defaultsFile = 'C:/ProgramData/MySQL/MySQL Server 26.10/my.ini';
const secretDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Windward');
const secretFile = path.join(secretDir, 'mysql-root-password.dpapi');
const quotePS = value => "'" + value.replace(/'/g, "''") + "'";
// Windows PowerShell must load its own modules, not inherit PowerShell 7's paths.
const shellEnv = { ...process.env };
delete shellEnv.PSModulePath;
const ps = (command, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
  input, env: shellEnv, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
}).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (process.argv.includes('--show-password')) {
    if (!fs.existsSync(secretFile)) throw new Error('No saved password was found.');
    const value = ps(`$ErrorActionPreference='Stop'; $cipher=(Get-Content -Raw -LiteralPath ${quotePS(secretFile)}).Trim(); $s=ConvertTo-SecureString -String $cipher; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); $s.Dispose()}`);
    console.log('Local MySQL root password (do not share):');
    console.log(value);
    return;
  }
  const elevated = ps('$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); [Console]::Write($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))');
  if (elevated !== 'True') {
    if (process.argv.includes('--elevated-console')) throw new Error('Elevation was not granted.');
    console.log('Requesting administrator permission. Select Yes in the Windows prompt.');
    const childArgs = '"' + path.join(__dirname, 'reset-mysql.js') + '" --elevated-console';
    try {
      const code = ps(`$p=Start-Process -FilePath ${quotePS(process.execPath)} -ArgumentList ${quotePS(childArgs)} -WorkingDirectory ${quotePS(path.join(__dirname, '..'))} -Verb RunAs -WindowStyle Normal -Wait -PassThru -ErrorAction Stop; [Console]::Write($p.ExitCode)`);
      process.exitCode = Number(code) || 0;
    } catch {
      console.error('Administrator permission was not granted. No reset was performed in this terminal. Run npm run reset:mysql again and approve the Windows prompt.');
      process.exitCode = 1;
    }
    return;
  }
  ps(`Get-Service -Name '${serviceName}' -ErrorAction Stop | Out-Null`);
  fs.accessSync(mysqlBin);
  fs.accessSync(defaultsFile);
  fs.mkdirSync(secretDir, { recursive: true });
  // Save the new password using Windows DPAPI before touching the database.
  // Only the same Windows user can decrypt it; it is outside the synced project.
  const password = 'Ww9!' + crypto.randomBytes(28).toString('hex');
  if (fs.existsSync(secretFile)) {
    fs.copyFileSync(secretFile, secretFile + '.' + Date.now() + '.bak');
  }
  ps(`$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force; $s | ConvertFrom-SecureString | Set-Content -LiteralPath ${quotePS(secretFile)} -Encoding ASCII`, password);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windward-mysql-reset-'));
  const sid = ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  execFileSync('icacls.exe', [tempDir, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  const initFile = path.join(tempDir, 'reset.sql');
  fs.writeFileSync(initFile, "ALTER USER 'root'@'localhost' IDENTIFIED BY '" + password + "';\n", { flag: 'wx' });
  let manual;
  let connection;
  let stopped = false;
  let manualExited = false;
  try {
    console.log('Stopping MySQL service...');
    ps(`Stop-Service -Name '${serviceName}' -ErrorAction Stop; (Get-Service '${serviceName}').WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))`);
    stopped = true;
    manual = spawn(mysqlBin, ['--defaults-file=' + defaultsFile, '--init-file=' + initFile.replace(/\\/g, '/'), '--bind-address=127.0.0.1', '--mysqlx-bind-address=127.0.0.1', '--console'], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore']
    });
    let spawnError;
    manual.once('error', error => { spawnError = error; manualExited = true; });
    manual.once('exit', () => { manualExited = true; });
    for (let attempt = 0; attempt < 45; attempt++) {
      if (manualExited) throw new Error('The temporary MySQL server could not start.');
      if (spawnError) throw new Error('Unable to launch MySQL.');
      try {
        connection = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password, connectTimeout: 1500 });
        break;
      } catch { await delay(1000); }
    }
    if (!connection) throw new Error('Could not verify the new root password.');
    console.log('New root password verified. Restoring the normal MySQL service...');
    await connection.query('SHUTDOWN');
    await connection.end();
    connection = null;
    for (let attempt = 0; attempt < 30 && !manualExited; attempt++) await delay(1000);
    if (!manualExited) throw new Error('MySQL shutdown is still pending. Do not start a second server.');
    ps(`Start-Service -Name '${serviceName}' -ErrorAction Stop; (Get-Service '${serviceName}').WaitForStatus('Running',[TimeSpan]::FromSeconds(30))`);
    stopped = false;
    connection = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password, connectTimeout: 10000 });
    await connection.query('SELECT 1');
    await connection.end();
    connection = null;
    console.log('Password reset complete. Setting up the game database...');
    if (!fs.existsSync(path.join(__dirname, '..', '.env.mysql.json'))) {
      execFileSync(process.execPath, [path.join(__dirname, 'setup-mysql.js')], {
        input: JSON.stringify({ user: 'root', password }), stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
      });
    } else {
      console.log('Existing game connection configuration was preserved.');
    }
    console.log('Root password saved with Windows encryption. To view it yourself: npm run mysql:password');
    console.log('Start the game: npm run start:local');
  } finally {
    if (connection) await connection.end().catch(() => {});
    if (stopped && (!manual || manualExited)) {
      try { ps(`Start-Service -Name '${serviceName}' -ErrorAction Stop`); }
      catch { console.error('Please start MySQL2610 from Windows Services.'); }
    }
    if (stopped && manual && !manualExited) console.error('Temporary MySQL is still running. Close it cleanly before restarting MySQL2610. The new password is available with npm run mysql:password.');
    fs.rmSync(initFile, { force: true });
    fs.rmdirSync(tempDir);
  }
}
main().catch(error => {
  // Child process errors can contain SQL or credential-bearing input: never print them.
  const safeMessages = new Set([
    'No saved password was found.', 'The temporary MySQL server could not start.', 'Unable to launch MySQL.',
    'Could not verify the new root password.', 'MySQL shutdown is still pending. Do not start a second server.'
  ]);
  console.error(safeMessages.has(error.message) ? error.message : 'MySQL reset did not complete. Check administrator permission and the MySQL service.');
  process.exitCode = 1;
}).finally(async () => {
  if (process.argv.includes('--elevated-console') && process.stdin.isTTY) {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => rl.question('\nPress Enter to close this window...', resolve));
    rl.close();
  }
});
