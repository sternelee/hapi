import { piLocal } from './piLocal';
import { PiSession } from './session';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

export async function piLocalLauncher(session: PiSession): Promise<'switch' | 'exit'> {
    const resumeSessionId = session.sessionId;
    if (resumeSessionId) {
        session.onSessionFound(resumeSessionId);
    }

    const launcher = new BaseLocalLauncher({
        label: 'pi-local',
        failureLabel: 'Local Pi process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            const model = session.getModel();
            await piLocal({
                path: session.path,
                sessionId: resumeSessionId,
                abort: abortSignal,
                model: model != null ? model : undefined
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    return launcher.run();
}
