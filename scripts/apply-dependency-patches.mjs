import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const bridgeManagerPath = path.join(
  repoRoot,
  'node_modules',
  'claude-to-im',
  'src',
  'lib',
  'bridge',
  'bridge-manager.ts',
);

const original = [
  '      const binding = router.resolve(msg.address);',
  '      router.updateBinding(binding.id, { workingDirectory: validatedPath });',
  '      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;',
].join('\n');

const replacement = [
  '      const binding = router.resolve(msg.address);',
  '      const { store } = getBridgeContext();',
  "      router.updateBinding(binding.id, { workingDirectory: validatedPath, sdkSessionId: '' });",
  "      store.updateSdkSessionId(binding.codepilotSessionId, '');",
  "      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>\\nA fresh runtime session will be started on the next message.`;",
].join('\n');

if (!fs.existsSync(bridgeManagerPath)) {
  console.log('[postinstall] Skip claude-to-im patch: dependency source not installed yet.');
  process.exit(0);
}

const content = fs.readFileSync(bridgeManagerPath, 'utf-8');
if (content.includes(replacement)) {
  console.log('[postinstall] claude-to-im /cwd patch already applied.');
  process.exit(0);
}

if (!content.includes(original)) {
  console.warn('[postinstall] Unable to locate expected /cwd block in claude-to-im bridge-manager.ts.');
  process.exit(0);
}

fs.writeFileSync(bridgeManagerPath, content.replace(original, replacement), 'utf-8');
console.log('[postinstall] Applied claude-to-im /cwd patch.');