import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRuntimeForSession } from '../multi-runtime-provider.js';
import type { RuntimeChannelBinding } from '../store.js';

describe('resolveRuntimeForSession', () => {
  it('returns the binding runtime when present', () => {
    const bindings: RuntimeChannelBinding[] = [
      {
        id: 'binding-1',
        channelType: 'discord',
        chatId: 'chat-1',
        codepilotSessionId: 'session-1',
        sdkSessionId: '',
        workingDirectory: '/tmp',
        model: 'gpt-5.4',
        mode: 'code',
        active: true,
        createdAt: '2026-03-25T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z',
        runtime: 'codex',
      },
    ];

    assert.equal(resolveRuntimeForSession('session-1', bindings, 'copilot'), 'codex');
  });

  it('falls back to the configured default runtime', () => {
    const bindings: RuntimeChannelBinding[] = [
      {
        id: 'binding-2',
        channelType: 'discord',
        chatId: 'chat-2',
        codepilotSessionId: 'session-2',
        sdkSessionId: '',
        workingDirectory: '/tmp',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '2026-03-25T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z',
      },
    ];

    assert.equal(resolveRuntimeForSession('session-2', bindings, 'copilot'), 'copilot');
    assert.equal(resolveRuntimeForSession('missing-session', bindings, 'auto'), 'auto');
  });
});