const _inFlight = new Map();

export async function inFlightSteer(ctx, next) {
    if (ctx.peerId === 'system') {
        await next();
        return;
    }

    const key = ctx.groupId || ctx.peerId;

    if (_inFlight.has(key)) {
        ctx.isSteer = true;
        console.log(`[agentthere:inflight] steer key=${key} msgId=${ctx.msgId}`);
        await next();
        return;
    }

    console.log(`[agentthere:inflight] start key=${key} msgId=${ctx.msgId}`);
    _inFlight.set(key, { msgId: ctx.msgId });
    try {
        await next();
    } finally {
        _inFlight.delete(key);
        console.log(`[agentthere:inflight] done key=${key} msgId=${ctx.msgId}`);
    }
}
