import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';

export async function piLocal(opts: {
    path: string;
    sessionId: string | null;
    abort: AbortSignal;
    model?: string;
}): Promise<void> {
    const args: string[] = [];

    if (opts.sessionId) {
        if (process.platform === 'win32' && /[&|<>^()%!"\r\n]/u.test(opts.sessionId)) {
            throw new Error('Invalid sessionId');
        }
        args.push('--session', opts.sessionId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }

    logger.debug(`[PiLocal] Spawning pi with args: ${JSON.stringify(args)}`);

    await spawnWithTerminalGuard({
        command: 'pi',
        args,
        cwd: opts.path,
        env: process.env,
        signal: opts.abort,
        shell: process.platform === 'win32',
        logLabel: 'PiLocal',
        spawnName: 'pi',
        installHint: 'Pi coding agent (npm install -g @mariozechner/pi-coding-agent)',
        includeCause: true,
        logExit: true
    });
}
