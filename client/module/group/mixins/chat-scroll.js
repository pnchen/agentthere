/**
 * Chat scroll mixin
 * - Smart auto-scroll (only when user is near bottom)
 * - Wheel/touch event tracking (NOT scroll events, which fire from programmatic scrolls)
 * - Visual viewport binding for iOS keyboard
 * - New messages indicator (hasNewMessagesBelow)
 */
// ── Smart auto-scroll constants ─────────────────────────────────────────────
// Distance (px) from bottom within which we consider user "near bottom".
var NEAR_BOTTOM_THRESHOLD = 350;

export default {
	data() {
		return {
			hasNewMessagesBelow: false
		};
	},
	created() {
		// ── scroll tracking ──────────────────────────────────────────────────
		// ONLY uses wheel/touch events (never scroll events) for tracking.
		// Reason: window.scrollTo({ behavior: 'smooth' }) fires scroll events
		// that look identical to user scroll — the scroll listener would
		// re-engage auto-scroll during the animation, defeating user disengage.
		// wheel/touch events fire ONLY from real user interaction.
		this._userNearBottom = true;
		this._scrollRafId = null;
		this._touchStartY = 0;
		this._lastProgrammaticScrollAt = 0;
		// Protection window after programmatic smooth scroll (ms)
		// Ignore wheel/touch-up disengage within this window to avoid false triggers
		var PROGRAMMATIC_SCROLL_GUARD = 700;

		// wheel: deltaY < 0 = scroll up → disengage
		//         deltaY > 0 = scroll down → re-engage if near bottom
		this._onWheel = e => {
			if (e.deltaY < 0) {
				// During scroll protection window, ignore wheel-up (may be smooth animation or inertia)
				if (Date.now() - this._lastProgrammaticScrollAt < PROGRAMMATIC_SCROLL_GUARD) return;
				this._userNearBottom = false;
			} else if (e.deltaY > 0) {
				var el = document.scrollingElement || document.documentElement;
				var distance = el.scrollHeight - el.scrollTop - el.clientHeight;
				if (distance < NEAR_BOTTOM_THRESHOLD) {
					this._userNearBottom = true;
					this.hasNewMessagesBelow = false;
				}
			}
		};

		// touch: finger drag down (clientY increases) = page scrolls up → disengage
		//        finger drag up (clientY decreases) = page scrolls down → re-engage if near bottom
		this._onTouchStart = e => {
			if (e.touches.length === 1) {
				this._touchStartY = e.touches[0].clientY;
			}
		};
		this._onTouchMove = e => {
			if (e.touches.length === 1) {
				var delta = e.touches[0].clientY - this._touchStartY;
				if (delta > 10) {
					// finger moved down = page scrolls up → disengage
					// Ignore during protection window (avoid inertial touch events before scroll completes)
					if (Date.now() - this._lastProgrammaticScrollAt < PROGRAMMATIC_SCROLL_GUARD) return;
					this._userNearBottom = false;
				} else if (delta < -10) {
					// finger moved up = page scrolls down → re-engage if near bottom
					var el = document.scrollingElement || document.documentElement;
					var distance = el.scrollHeight - el.scrollTop - el.clientHeight;
					if (distance < NEAR_BOTTOM_THRESHOLD) {
						this._userNearBottom = true;
						this.hasNewMessagesBelow = false;
					}
				}
			}
		};

		window.addEventListener('wheel', this._onWheel, { passive: true });
		window.addEventListener('touchstart', this._onTouchStart, { passive: true });
		window.addEventListener('touchmove', this._onTouchMove, { passive: true });
	},
	beforeUnmount() {
		window.removeEventListener('wheel', this._onWheel, { passive: true });
		window.removeEventListener('touchstart', this._onTouchStart, { passive: true });
		window.removeEventListener('touchmove', this._onTouchMove, { passive: true });
		if (this._scrollRafId) cancelAnimationFrame(this._scrollRafId);
	},
	mounted() {},
	methods: {
		/**
		 * Smart scroll-to-bottom — only scrolls when user is near the bottom.
		 * Uses rAF + Vue $nextTick for accurate timing (no fixed delay).
		 * When user has scrolled up, sets hasNewMessagesBelow flag instead.
		 * @param {object} [opts]
		 * @param {boolean} [opts.force] — force scroll regardless of position
		 * @param {boolean} [opts.immediate] — skip smooth animation
		 */
		scheduleScrollToBottom(opts) {
			var force = opts && opts.force;
			var immediate = opts && opts.immediate;
			if (this._scrollRafId) cancelAnimationFrame(this._scrollRafId);
			this.$nextTick(() => {
				this._scrollRafId = requestAnimationFrame(() => {
					this._scrollRafId = null;
					var el = document.scrollingElement || document.documentElement;
					if (!force && !this._userNearBottom) {
						// Only show indicator when page is actually scrollable
						if (el.scrollHeight > el.clientHeight + 10) {
							this.hasNewMessagesBelow = true;
						}
						return;
					}
					window.scrollTo({
						top: el.scrollHeight,
						behavior: immediate ? 'auto' : 'smooth'
					});
					// Only guard against inertia wheel events after smooth scrolls.
					// Instant (immediate) scrolls have no animation, so no momentum
					// inertia events are generated — no guard needed.
					if (!immediate) {
						this._lastProgrammaticScrollAt = Date.now();
					}
					this.hasNewMessagesBelow = false;
				});
			});
		},
		scrollToBottomNow() {
			var el = document.scrollingElement || document.documentElement;
			window.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
			this._lastProgrammaticScrollAt = Date.now();
			this.hasNewMessagesBelow = false;
			this._userNearBottom = true;
		}
	}
};
