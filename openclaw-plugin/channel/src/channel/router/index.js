/**
 * Router — lightweight Koa-style middleware kernel.
 *
 * Usage:
 *   const router = new Router();
 *   router.use('/message', mentionDetection, followUpWindow, ...);
 *   router.catch(errorHandler);
 *
 *   await router.process('/message', ctx);
 *
 * Middleware signature: async (ctx, next) => void
 *   - Call `await next()` to continue the chain.
 *   - Do NOT call `next()` to short-circuit (halt the chain).
 *   - Throw to trigger the error handler registered via `router.catch()`.
 */

/**
 * Compose an array of middleware into a single callable chain.
 * Each middleware receives `(ctx, next)`. Calling `next()` invokes the
 * next handler; not calling it halts the chain.
 * @param {Array<(ctx: object, next: () => Promise<void>) => Promise<void>>} handlers
 * @returns {(ctx: object) => Promise<void>}
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
		/** @type {Map<string, Array<Function>>} */
		this._routes = new Map();
		/** @type {Function|null} */
		this._errorHandler = null;
	}

	/**
	 * Register middleware for a path.
	 *   router.use('/message', fn1, fn2, fn3)
	 *
	 * Handlers are invoked in registration order.
	 * @param {string} path
	 * @param  {...Function} handlers
	 */
	use(path, ...handlers) {
		if (!this._routes.has(path)) {
			this._routes.set(path, []);
		}
		this._routes.get(path).push(...handlers);
	}

	/**
	 * Register a global error handler.
	 *   router.catch(async (ctx, err) => { ... })
	 * @param {Function} handler
	 */
	catch(handler) {
		this._errorHandler = handler;
	}

	/**
	 * Process a request through the middleware chain registered for `path`.
	 * @param {string} path — route key (e.g. '/message', '/media')
	 * @param {object} ctx — the request context
	 */
	async process(path, ctx) {
		const chain = this._routes.get(path);
		if (!chain || chain.length === 0) return;

		try {
			ctx.path = path;
			await compose(chain)(ctx);
		} catch (err) {
			if (this._errorHandler) {
				await this._errorHandler(ctx, err);
			} else {
				console.error(`[router] unhandled error on ${path}:`, err);
			}
		}
	}
}
