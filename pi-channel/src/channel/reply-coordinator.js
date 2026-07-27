/**
 * Coordinates the single AgentSession event stream.
 *
 * Text and voice replies share one session, so there must be one event
 * subscriber and one active reply owner at a time. Voice temporarily installs
 * a sink for its round; when no voice sink is active, events go to text.
 */
export class ReplyCoordinator {
    constructor(session, onTextEvent, onLifecycleEvent = null) {
        this.session = session;
        this.onTextEvent = onTextEvent;
        this.onLifecycleEvent = onLifecycleEvent;
        this.voiceReply = null;
        this.unsubscribe = null;
    }

    start() {
        if (this.unsubscribe) return;
        this.unsubscribe = this.session.subscribe((event) => this.handle(event));
    }

    stop() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.voiceReply = null;
    }

    setVoiceReply(round, onEvent) {
        this.voiceReply = { round, onEvent };
    }

    clearVoiceReply(round) {
        if (!round || this.voiceReply?.round === round) {
            this.voiceReply = null;
        }
    }

    handle(event) {
        this.onLifecycleEvent?.(event);
        const voiceReply = this.voiceReply;
        if (voiceReply && !voiceReply.round?._finalized) {
            voiceReply.onEvent(event);
            return;
        }
        this.voiceReply = null;
        this.onTextEvent(event);
    }
}
