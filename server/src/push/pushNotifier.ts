import type { Session, SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { PushPayload, PushService } from './pushService'

export class PushNotifier {
    private readonly lastKnownRequests: Map<string, Set<string>> = new Map()
    private readonly notificationDebounce: Map<string, NodeJS.Timeout> = new Map()
    private readonly lastReadyNotificationAt: Map<string, number> = new Map()
    private unsubscribeSyncEvents: (() => void) | null = null

    constructor(
        private readonly syncEngine: SyncEngine,
        private readonly pushService: PushService,
        private readonly appUrl: string
    ) {
        this.unsubscribeSyncEvents = this.syncEngine.subscribe((event) => {
            this.handleSyncEvent(event)
        })
    }

    stop(): void {
        if (this.unsubscribeSyncEvents) {
            this.unsubscribeSyncEvents()
            this.unsubscribeSyncEvents = null
        }

        for (const timer of this.notificationDebounce.values()) {
            clearTimeout(timer)
        }
        this.notificationDebounce.clear()
        this.lastKnownRequests.clear()
        this.lastReadyNotificationAt.clear()
    }

    private handleSyncEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            const session = this.syncEngine.getSession(event.sessionId)
            if (!session || !session.active) {
                this.clearSessionState(event.sessionId)
                return
            }
            this.checkForPermissionNotification(session)
        }

        if (event.type === 'session-removed' && event.sessionId) {
            this.clearSessionState(event.sessionId)
        }

        if (event.type === 'message-received' && event.sessionId) {
            const message = (event.message?.content ?? event.data) as unknown
            const messageContent = message as { type?: string; data?: { type?: string } }
            const eventType = messageContent?.type === 'event' ? messageContent?.data?.type : null

            if (eventType === 'ready') {
                this.sendReadyNotification(event.sessionId).catch((error) => {
                    console.error('[PushNotifier] Failed to send ready notification:', error)
                })
            }
        }
    }

    private clearSessionState(sessionId: string): void {
        const existingTimer = this.notificationDebounce.get(sessionId)
        if (existingTimer) {
            clearTimeout(existingTimer)
            this.notificationDebounce.delete(sessionId)
        }
        this.lastKnownRequests.delete(sessionId)
        this.lastReadyNotificationAt.delete(sessionId)
    }

    private getNotifiableSession(sessionId: string): Session | null {
        const session = this.syncEngine.getSession(sessionId)
        if (!session || !session.active) {
            return null
        }
        return session
    }

    private checkForPermissionNotification(session: Session): void {
        const currentSession = this.getNotifiableSession(session.id)
        if (!currentSession) {
            return
        }

        const requests = currentSession.agentState?.requests
        if (requests == null) {
            return
        }

        const newRequestIds = new Set(Object.keys(requests))
        const oldRequestIds = this.lastKnownRequests.get(session.id) || new Set()

        let hasNewRequests = false
        for (const requestId of newRequestIds) {
            if (!oldRequestIds.has(requestId)) {
                hasNewRequests = true
                break
            }
        }

        this.lastKnownRequests.set(session.id, newRequestIds)

        if (!hasNewRequests) {
            return
        }

        const existingTimer = this.notificationDebounce.get(currentSession.id)
        if (existingTimer) {
            clearTimeout(existingTimer)
        }

        const timer = setTimeout(() => {
            this.notificationDebounce.delete(currentSession.id)
            this.sendPermissionNotification(currentSession.id).catch((error) => {
                console.error('[PushNotifier] Failed to send permission notification:', error)
            })
        }, 500)

        this.notificationDebounce.set(currentSession.id, timer)
    }

    private async sendPermissionNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const name = this.getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const payload: PushPayload = {
            title: 'Permission Request',
            body: `${name}${toolName}`,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url: this.buildSessionUrl(session.id)
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private async sendReadyNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const now = Date.now()
        const last = this.lastReadyNotificationAt.get(sessionId) ?? 0
        if (now - last < 5000) {
            return
        }
        this.lastReadyNotificationAt.set(sessionId, now)

        const agentName = this.getAgentName(session)
        const name = this.getSessionName(session)

        const payload: PushPayload = {
            title: 'Ready for input',
            body: `${agentName} is waiting in ${name}`,
            tag: `ready-${session.id}`,
            data: {
                type: 'ready',
                sessionId: session.id,
                url: this.buildSessionUrl(session.id)
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private getSessionName(session: Session): string {
        if (session.metadata?.name) return session.metadata.name
        if (session.metadata?.summary?.text) return session.metadata.summary.text
        if (session.metadata?.path) {
            const parts = session.metadata.path.split('/').filter(Boolean)
            return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
        }
        return session.id.slice(0, 8)
    }

    private getAgentName(session: Session): string {
        const flavor = session.metadata?.flavor
        if (flavor === 'claude') return 'Claude'
        if (flavor === 'codex') return 'Codex'
        if (flavor === 'gemini') return 'Gemini'
        return 'Agent'
    }

    private buildSessionUrl(sessionId: string): string {
        try {
            const baseUrl = new URL(this.appUrl)
            const basePath = baseUrl.pathname === '/'
                ? ''
                : baseUrl.pathname.replace(/\/$/, '')
            baseUrl.pathname = `${basePath}/sessions/${sessionId}`
            baseUrl.search = ''
            baseUrl.hash = ''
            return baseUrl.toString()
        } catch {
            const trimmed = this.appUrl.replace(/\/$/, '')
            return `${trimmed}/sessions/${sessionId}`
        }
    }
}
