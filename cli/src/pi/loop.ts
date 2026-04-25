import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { PiSession } from './session';
import { piLocalLauncher } from './piLocalLauncher';
import { piRemoteLauncher } from './piRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { PiMode, PermissionMode } from './types';

interface PiLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<PiMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    resumeSessionId?: string;
    onSessionReady?: (session: PiSession) => void;
}

export async function piLoop(opts: PiLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new PiSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.resumeSessionId ?? null,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        model: opts.model,
        permissionMode: opts.permissionMode ?? 'default'
    });

    if (opts.resumeSessionId) {
        session.onSessionFound(opts.resumeSessionId);
    }

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'pi-loop',
        runLocal: piLocalLauncher,
        runRemote: piRemoteLauncher,
        onSessionReady: opts.onSessionReady
    });
}
