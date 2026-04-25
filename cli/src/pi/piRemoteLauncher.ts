import React from 'react';
import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';
import { convertAgentMessage } from '@/agent/messageConverter';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import type { PiSession } from './session';
import type { AgentMessage } from '@/agent/types';

// Pi RPC events emitted to stdout
interface PiRpcSessionEvent {
    type: 'session';
    id: string;
    version?: number;
    timestamp?: string;
    cwd?: string;
}

interface PiRpcResponseEvent {
    type: 'response';
    command: string;
    success: boolean;
    data?: {
        sessionId?: string;
        isStreaming?: boolean;
        [key: string]: unknown;
    };
    id?: string;
}

interface PiRpcAgentStartEvent { type: 'agent_start' }
interface PiRpcAgentEndEvent { type: 'agent_end'; messages?: unknown[] }
interface PiRpcTurnStartEvent { type: 'turn_start' }
interface PiRpcTurnEndEvent { type: 'turn_end' }

interface PiRpcMessageUpdateEvent {
    type: 'message_update';
    message?: unknown;
    assistantMessageEvent?: {
        type: string;
        delta?: string;
    };
}

interface PiRpcToolExecutionStartEvent {
    type: 'tool_execution_start';
    toolCallId: string;
    toolName: string;
    args?: unknown;
}

interface PiRpcToolExecutionEndEvent {
    type: 'tool_execution_end';
    toolCallId: string;
    toolName: string;
    result?: unknown;
    isError?: boolean;
}

type PiRpcEvent =
    | PiRpcSessionEvent
    | PiRpcResponseEvent
    | PiRpcAgentStartEvent
    | PiRpcAgentEndEvent
    | PiRpcTurnStartEvent
    | PiRpcTurnEndEvent
    | PiRpcMessageUpdateEvent
    | PiRpcToolExecutionStartEvent
    | PiRpcToolExecutionEndEvent
    | { type: string; [key: string]: unknown };

function parsePiRpcEvent(line: string): PiRpcEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed) as PiRpcEvent;
    } catch {
        return null;
    }
}

class PiRemoteLauncher extends RemoteLauncherBase {
    private readonly session: PiSession;
    private piProcess: ReturnType<typeof spawn> | null = null;
    private abortController = new AbortController();
    private displayPermissionMode: string | null = null;
    private pendingResponses = new Map<string, (response: PiRpcResponseEvent) => void>();
    private responseIdCounter = 0;

    constructor(session: PiSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(OpencodeDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const args = ['--mode', 'rpc'];
        if (session.sessionId) {
            args.push('--session', session.sessionId);
        }
        const model = session.getModel();
        if (model) {
            args.push('--model', model);
        }

        logger.debug(`[pi-remote] Spawning pi with args: ${args.join(' ')}`);

        const piProcess = spawn('pi', args, {
            cwd: session.path,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32'
        });
        this.piProcess = piProcess;

        piProcess.on('error', (err) => {
            logger.warn('[pi-remote] Process error', err);
            const msg = err.message.includes('ENOENT')
                ? 'Pi not found. Install with: npm install -g @mariozechner/pi-coding-agent'
                : `Pi process error: ${err.message}`;
            session.sendSessionEvent({ type: 'message', message: msg });
            messageBuffer.addMessage(msg, 'status');
        });

        piProcess.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) {
                logger.debug('[pi-remote] stderr:', text);
            }
        });

        // Use custom LF-based line splitting (Pi RPC requires LF only)
        let stdoutBuf = '';
        piProcess.stdout?.on('data', (chunk: Buffer) => {
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop() ?? '';
            for (const line of lines) {
                const event = parsePiRpcEvent(line);
                if (event) {
                    this.handleRpcEvent(event);
                }
            }
        });

        // Get session ID after startup via get_state
        const stateResponse = await this.sendRpcCommand({ type: 'get_state' });
        if (stateResponse?.success && stateResponse.data?.sessionId) {
            session.onSessionFound(stateResponse.data.sessionId as string);
        }

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const waitSignal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            this.applyDisplayMode(batch.mode.permissionMode as string);
            messageBuffer.addMessage(batch.message, 'user');

            session.onThinkingChange(true);

            try {
                await this.sendPromptAndWait(batch.message);
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.warn('[pi-remote] Prompt failed', error);
                session.sendSessionEvent({ type: 'message', message: `Pi prompt failed: ${errMsg}` });
                messageBuffer.addMessage(`Pi prompt failed: ${errMsg}`, 'status');
            } finally {
                session.onThinkingChange(false);
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }

        if (piProcess.exitCode === null) {
            killProcessByChildProcess(piProcess, false).catch(() => {});
        }
    }

    private handleRpcEvent(event: PiRpcEvent): void {
        if (event.type === 'response') {
            const resp = event as PiRpcResponseEvent;
            if (resp.id) {
                const resolve = this.pendingResponses.get(resp.id);
                if (resolve) {
                    this.pendingResponses.delete(resp.id);
                    resolve(resp);
                }
            }
            return;
        }

        if (event.type === 'agent_end') {
            this.onAgentEnd();
            return;
        }

        if (event.type === 'message_update') {
            const update = event as PiRpcMessageUpdateEvent;
            if (update.assistantMessageEvent?.type === 'text_delta' && update.assistantMessageEvent.delta) {
                this.accumulateText(update.assistantMessageEvent.delta);
            }
            return;
        }

        if (event.type === 'tool_execution_start') {
            const toolEvent = event as PiRpcToolExecutionStartEvent;
            this.messageBuffer.addMessage(`Tool: ${toolEvent.toolName}`, 'tool');
            const agentMsg: AgentMessage = {
                type: 'tool_call',
                id: toolEvent.toolCallId,
                name: toolEvent.toolName,
                input: toolEvent.args ?? {},
                status: 'in_progress'
            };
            const converted = convertAgentMessage(agentMsg);
            if (converted) {
                this.session.sendAgentMessage(converted);
            }
            return;
        }

        if (event.type === 'tool_execution_end') {
            const toolEvent = event as PiRpcToolExecutionEndEvent;
            const agentMsg: AgentMessage = {
                type: 'tool_result',
                id: toolEvent.toolCallId,
                output: toolEvent.result ?? null,
                status: toolEvent.isError ? 'failed' : 'completed'
            };
            const converted = convertAgentMessage(agentMsg);
            if (converted) {
                this.session.sendAgentMessage(converted);
            }
            this.messageBuffer.addMessage('Tool result', 'result');
        }
    }

    private accumulatedText = '';

    private accumulateText(delta: string): void {
        this.accumulatedText += delta;
    }

    private onAgentEnd(): void {
        if (this.accumulatedText) {
            const agentMsg: AgentMessage = { type: 'text', text: this.accumulatedText };
            const converted = convertAgentMessage(agentMsg);
            if (converted) {
                this.session.sendAgentMessage(converted);
            }
            this.messageBuffer.addMessage(this.accumulatedText, 'assistant');
            this.accumulatedText = '';
        }
        const resolve = this.agentEndResolve;
        this.agentEndResolve = null;
        resolve?.();
    }

    private agentEndResolve: (() => void) | null = null;

    private sendPromptAndWait(message: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.agentEndResolve = resolve;

            if (!this.piProcess || this.piProcess.exitCode !== null) {
                reject(new Error('Pi process is not running'));
                return;
            }

            const command = JSON.stringify({ type: 'prompt', message }) + '\n';
            this.piProcess.stdin?.write(command, (err) => {
                if (err) {
                    this.agentEndResolve = null;
                    reject(err);
                }
            });
        });
    }

    private sendRpcCommand(command: { type: string; [key: string]: unknown }): Promise<PiRpcResponseEvent | null> {
        return new Promise<PiRpcResponseEvent | null>((resolve) => {
            if (!this.piProcess || this.piProcess.exitCode !== null) {
                resolve(null);
                return;
            }

            const id = `req-${++this.responseIdCounter}`;
            const payload = JSON.stringify({ ...command, id }) + '\n';

            const timeout = setTimeout(() => {
                this.pendingResponses.delete(id);
                resolve(null);
            }, 5000);

            this.pendingResponses.set(id, (response) => {
                clearTimeout(timeout);
                resolve(response);
            });

            this.piProcess.stdin?.write(payload, (err) => {
                if (err) {
                    clearTimeout(timeout);
                    this.pendingResponses.delete(id);
                    resolve(null);
                }
            });
        });
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        this.abortController.abort();

        if (this.piProcess && this.piProcess.exitCode === null) {
            killProcessByChildProcess(this.piProcess, false).catch(() => {});
        }
        this.piProcess = null;
        this.pendingResponses.clear();
        this.agentEndResolve = null;
    }

    private applyDisplayMode(permissionMode: string | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
    }

    private async handleAbort(): Promise<void> {
        if (this.piProcess && this.piProcess.exitCode === null) {
            const abortCmd = JSON.stringify({ type: 'abort' }) + '\n';
            this.piProcess.stdin?.write(abortCmd);
        }
        this.agentEndResolve?.();
        this.agentEndResolve = null;
        this.session.queue.reset();
        this.session.onThinkingChange(false);
        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }
}

export async function piRemoteLauncher(session: PiSession): Promise<'switch' | 'exit'> {
    const launcher = new PiRemoteLauncher(session);
    return launcher.launch();
}
