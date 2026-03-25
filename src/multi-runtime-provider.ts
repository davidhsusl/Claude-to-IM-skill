import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from './config.js';
import { CodexProvider } from './codex-provider.js';
import { CopilotProvider } from './copilot-provider.js';
import { preflightCheck, resolveClaudeCliPath, SDKLLMProvider } from './llm-provider.js';
import type { PendingPermissions } from './permission-gateway.js';
import type { RuntimeChannelBinding, RuntimeName } from './store.js';
import { sseEvent } from './sse-utils.js';

type ConcreteRuntime = Exclude<RuntimeName, 'auto'>;

export function resolveRuntimeForSession(
  sessionId: string,
  bindings: RuntimeChannelBinding[],
  fallbackRuntime: RuntimeName,
): RuntimeName {
  const binding = bindings.find((entry) => entry.codepilotSessionId === sessionId);
  return binding?.runtime || fallbackRuntime;
}

function errorStream(message: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(sseEvent('error', message));
      controller.close();
    },
  });
}

export class MultiRuntimeProvider implements LLMProvider {
  private readonly providers = new Map<ConcreteRuntime, LLMProvider>();

  constructor(
    private readonly pendingPerms: PendingPermissions,
    private readonly fallbackRuntime: RuntimeName,
    private readonly autoApprove = false,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    try {
      const runtime = this.resolveRuntime(params.sessionId);
      const provider = this.resolveProvider(runtime);
      return provider.streamChat(params);
    } catch (error) {
      return errorStream(error instanceof Error ? error.message : String(error));
    }
  }

  private resolveRuntime(sessionId: string): RuntimeName {
    const { store } = getBridgeContext();
    return resolveRuntimeForSession(
      sessionId,
      store.listChannelBindings() as RuntimeChannelBinding[],
      this.fallbackRuntime,
    );
  }

  private resolveProvider(runtime: RuntimeName): LLMProvider {
    if (runtime === 'auto') {
      try {
        return this.getOrCreateProvider('claude');
      } catch (error) {
        console.warn(
          `[multi-runtime-provider] Auto runtime falling back to Codex: ${error instanceof Error ? error.message : String(error)}`,
        );
        return this.getOrCreateProvider('codex');
      }
    }

    return this.getOrCreateProvider(runtime);
  }

  private getOrCreateProvider(runtime: ConcreteRuntime): LLMProvider {
    const existing = this.providers.get(runtime);
    if (existing) {
      return existing;
    }

    const created = this.createProvider(runtime);
    this.providers.set(runtime, created);
    return created;
  }

  private createProvider(runtime: ConcreteRuntime): LLMProvider {
    switch (runtime) {
      case 'claude': {
        const cliPath = resolveClaudeCliPath();
        if (!cliPath) {
          throw new Error(
            '[multi-runtime-provider] Cannot find the `claude` CLI executable. ' +
            'Install Claude Code CLI or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude',
          );
        }
        const check = preflightCheck(cliPath);
        if (!check.ok) {
          throw new Error(
            `[multi-runtime-provider] Claude CLI preflight failed at ${cliPath}: ${check.error || 'unknown error'}`,
          );
        }
        return new SDKLLMProvider(this.pendingPerms, cliPath, this.autoApprove);
      }
      case 'codex':
        return new CodexProvider(this.pendingPerms);
      case 'copilot':
        return new CopilotProvider();
    }
  }
}