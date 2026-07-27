/**
 * Router — lightweight Koa-style middleware kernel.
 *
 * Mirrors openclaw-plugin/channel/src/channel/router/index.js.
 *
 * Usage:
 *   const router = new Router();
 *   router.use('/message', authGate, messageHandler);
 *   router.use('/call',   authGate, callHandler);
 *
 *   await router.process('/message', ctx);
 *
 * Middleware signature: async (ctx, next) => void
 *   - Call `await next()` to continue the chain.
 *   - Do NOT call `next()` to short-circuit.
 */

function compose(handlers) {
    return async (ctx) => {
        let i = 0;
        async function next() {
            if (i >= handlers.length) return;
            const handler = handlers[i++];
            await handler(ctx, next);
        }
        await next();
    };
}

export class Router {
    constructor() {
        this._routes = new Map();
        this._errorHandler = null;
    }

    use(path, ...handlers) {
        if (!this._routes.has(path)) {
            this._routes.set(path, []);
        }
        this._routes.get(path).push(...handlers);
    }

    catch(handler) {
        this._errorHandler = handler;
    }

    async process(path, ctx) {
        const chain = this._routes.get(path);
        if (!chain || chain.length === 0) return;

        try {
            ctx.path = path;
            await compose(chain)(ctx);
        }
        catch (err) {
            if (this._errorHandler) {
                await this._errorHandler(ctx, err);
            }
            else {
                console.error(`[router] unhandled error on ${path}:`, err);
            }
        }
    }
}
