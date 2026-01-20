import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'

export const openCodeCommand: CommandDefinition = {
    name: 'opencode',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            let startedBy: 'runner' | 'terminal' | undefined
            let yolo = false

            for (let i = 0; i < commandArgs.length; i++) {
                if (commandArgs[i] === '--started-by') {
                    startedBy = commandArgs[++i] as 'runner' | 'terminal'
                } else if (commandArgs[i] === '--yolo') {
                    yolo = true
                }
            }

            const { registerOpenCodeAgent } = await import('@/agent/runners/opencode')
            const { runAgentSession } = await import('@/agent/runners/runAgentSession')
            registerOpenCodeAgent(yolo)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            await runAgentSession({ agentType: 'opencode', startedBy })
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
