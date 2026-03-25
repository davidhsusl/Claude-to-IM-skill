import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCopilotSpawnCommand, resolveWindowsCopilotPath } from '../copilot-provider.js';

describe('resolveWindowsCopilotPath', () => {
  it('prefers a runnable cmd or bat shim over a ps1 launcher path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-copilot-path-'));

    try {
      const ps1Path = path.join(tmpDir, 'copilot.ps1');
      const batPath = path.join(tmpDir, 'copilot.bat');
      fs.writeFileSync(ps1Path, 'Write-Host test');
      fs.writeFileSync(batPath, '@echo off\r\necho test\r\n');

      assert.equal(resolveWindowsCopilotPath(ps1Path), batPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('buildCopilotSpawnCommand', () => {
  it('wraps bat shims with cmd.exe on Windows', () => {
    const command = buildCopilotSpawnCommand('C:/Users/test/copilot.bat', ['--version'], 'win32');

    assert.equal(command.command, 'cmd.exe');
    assert.deepEqual(command.args, ['/d', '/s', '/c', 'C:/Users/test/copilot.bat --version']);
  });

  it('wraps ps1 launchers with powershell on Windows', () => {
    const command = buildCopilotSpawnCommand('C:/Users/test/copilot.ps1', ['--version'], 'win32');

    assert.equal(command.command, 'powershell.exe');
    assert.deepEqual(command.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/Users/test/copilot.ps1', '--version']);
  });
});