import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FileAttachment, LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import { buildSubprocessEnv } from './llm-provider.js';
import { sseEvent } from './sse-utils.js';

interface CopilotEvent {
  type?: string;
  data?: Record<string, unknown>;
  sessionId?: string;
}

const COPILOT_CANDIDATES = [
  process.env.CTI_COPILOT_EXECUTABLE,
  '/opt/homebrew/bin/copilot',
  '/usr/local/bin/copilot',
  path.join(os.homedir(), '.local', 'bin', 'copilot'),
].filter((value): value is string => !!value);

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCopilotCliPath(): string | undefined {
  for (const candidate of COPILOT_CANDIDATES) {
    if (isExecutable(candidate)) return candidate;
  }

  try {
    const resolved = execSync('command -v copilot', {
      encoding: 'utf-8',
      env: buildSubprocessEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return resolved || undefined;
  } catch {
    return undefined;
  }
}

function buildPrompt(params: StreamChatParams): string {
  if (!params.conversationHistory || params.conversationHistory.length === 0) {
    return params.prompt;
  }

  const history = params.conversationHistory
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n\n');

  return `${history}\n\nUSER: ${params.prompt}`;
}

function saveImageAttachments(files: FileAttachment[] | undefined): string[] {
  if (!files || files.length === 0) return [];

  const savedPaths: string[] = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const ext = MIME_EXT[file.type] || '.png';
    const tmpPath = path.join(os.tmpdir(), `cti-copilot-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
    savedPaths.push(tmpPath);
  }
  return savedPaths;
}

export class CopilotProvider implements LLMProvider {
  private readonly cliPath: string;

  constructor() {
    const resolved = resolveCopilotCliPath();
    if (!resolved) {
      throw new Error(
        '[CopilotProvider] Cannot find the `copilot` CLI executable. ' +
        'Install GitHub Copilot CLI or set CTI_COPILOT_EXECUTABLE=/path/to/copilot'
      );
    }

    this.cliPath = resolved;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        const tempFiles = saveImageAttachments(params.files);
        const workingDirectory = params.workingDirectory || process.cwd();
        const prompt = buildPrompt(params);
        const args: string[] = [
          '--output-format', 'json',
          '--allow-all-tools',
          '--no-ask-user',
          '--add-dir', workingDirectory,
          '--prompt', prompt,
        ];

        if (params.model) {
          args.push('--model', params.model);
        }

        if (params.sdkSessionId) {
          args.push(`--resume=${params.sdkSessionId}`);
        }

        let childExited = false;
        let buffer = '';
        let finalText = '';
        let sessionId: string | undefined;
        let outputTokens = 0;
        const child = spawn(self.cliPath, args, {
          cwd: workingDirectory,
          env: buildSubprocessEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const cleanup = () => {
          for (const filePath of tempFiles) {
            try {
              fs.unlinkSync(filePath);
            } catch {
              // Ignore temp cleanup failures.
            }
          }
        };

        const closeWithError = (message: string) => {
          if (childExited) return;
          childExited = true;
          controller.enqueue(sseEvent('error', message));
          controller.close();
          cleanup();
        };

        if (params.abortController) {
          const onAbort = () => {
            try {
              child.kill('SIGTERM');
            } catch {
              // Ignore kill failures.
            }
          };

          if (params.abortController.signal.aborted) {
            onAbort();
          } else {
            params.abortController.signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk;

          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');

            if (!line) continue;

            let event: CopilotEvent;
            try {
              event = JSON.parse(line) as CopilotEvent;
            } catch {
              continue;
            }

            switch (event.type) {
              case 'assistant.message_delta': {
                const delta = typeof event.data?.deltaContent === 'string'
                  ? event.data.deltaContent
                  : '';
                if (delta) controller.enqueue(sseEvent('text', delta));
                break;
              }

              case 'assistant.message': {
                const content = typeof event.data?.content === 'string'
                  ? event.data.content
                  : '';
                const phase = typeof event.data?.phase === 'string'
                  ? event.data.phase
                  : '';
                if (phase === 'final_answer') {
                  finalText = content;
                }
                if (typeof event.data?.outputTokens === 'number') {
                  outputTokens = event.data.outputTokens;
                }
                break;
              }

              case 'tool.execution_start': {
                controller.enqueue(sseEvent('tool_use', {
                  id: event.data?.toolCallId,
                  name: event.data?.toolName,
                  input: event.data?.arguments ?? {},
                }));
                break;
              }

              case 'tool.execution_complete': {
                const success = event.data?.success === true;
                const resultContent = success
                  ? (event.data?.result as Record<string, unknown> | undefined)?.detailedContent
                    ?? (event.data?.result as Record<string, unknown> | undefined)?.content
                    ?? ''
                  : (event.data?.error as Record<string, unknown> | undefined)?.message
                    ?? 'Tool execution failed';

                controller.enqueue(sseEvent('tool_result', {
                  tool_use_id: event.data?.toolCallId,
                  content: typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent),
                  is_error: !success,
                }));
                break;
              }

              case 'result': {
                sessionId = event.sessionId;
                controller.enqueue(sseEvent('result', {
                  usage: outputTokens > 0 ? {
                    input_tokens: 0,
                    output_tokens: outputTokens,
                  } : undefined,
                  ...(sessionId ? { session_id: sessionId } : {}),
                }));
                break;
              }

              default:
                break;
            }
          }
        });

        let stderr = '';
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });

        child.on('error', (error) => {
          closeWithError(error.message);
        });

        child.on('close', (code, signal) => {
          if (childExited) return;
          childExited = true;

          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer.trim()) as CopilotEvent;
              if (event.type === 'result' && event.sessionId) {
                sessionId = event.sessionId;
              }
            } catch {
              // Ignore trailing partial JSON.
            }
          }

          if (code !== 0) {
            const detail = stderr.trim() || `copilot exited with code ${code ?? 1}${signal ? ` (signal: ${signal})` : ''}`;
            controller.enqueue(sseEvent('error', detail));
          } else if (!sessionId && finalText) {
            controller.enqueue(sseEvent('result', {
              usage: outputTokens > 0 ? {
                input_tokens: 0,
                output_tokens: outputTokens,
              } : undefined,
            }));
          }

          controller.close();
          cleanup();
        });
      },
    });
  }
}