import { AgentRegistry } from '@/agent/AgentRegistry';
import { AcpSdkBackend } from '@/agent/backends/acp';

function buildEnv(): Record<string, string> {
    return Object.keys(process.env).reduce((acc, key) => {
        const value = process.env[key];
        if (typeof value === 'string') {
            acc[key] = value;
        }
        return acc;
    }, {} as Record<string, string>);
}

export function registerOpenCodeAgent(yolo: boolean): void {
    // OpenCode uses 'acp' as a stable subcommand (unlike Gemini's --experimental-acp flag)
    // as ACP support is production-ready in OpenCode
    const args = ['acp'];
    if (yolo) args.push('--yolo');

    AgentRegistry.register('opencode', () => new AcpSdkBackend({
        command: 'opencode',
        args,
        env: buildEnv()
    }));
}
