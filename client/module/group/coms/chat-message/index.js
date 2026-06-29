import _ from 'underscore';
import moment from 'moment';
import numeral from 'numeral';
import marked from 'js/lib/marked';
import nativeFileItem from '../native-file-item/index.js';
import voiceItem from '../voice-item/index.js';
export default {
	components: {
		'native-file-item': nativeFileItem,
		'voice-item': voiceItem
	},
	mixins: [],
	data() {
		return {
			autoplay: false,
			copied: false
		};
	},
	props: ['target', 'me', 'prev'],
	template: require('./index.html?raw'),
	computed: {
		show_date() {
			if (!this.target || !this.target.date) return false;
			if (this.target.loading) return false;
			if (!this.prev || !this.prev.date) return true;
			return moment(this.target.date).diff(moment(this.prev.date), 'minutes') >= 5;
		},
		display_date() {
			var d = this.target && this.target.date;
			if (!d) return '';
			var m = moment(d);
			var now = moment();
			if (m.isSame(now, 'day')) return m.format('HH:mm');
			if (m.isSame(now.clone().subtract(1, 'day'), 'day')) return 'Yesterday ' + m.format('HH:mm');
			if (m.isSame(now, 'year')) return m.format('MM-DD HH:mm');
			return m.format('YYYY-MM-DD HH:mm');
		},
		cache_rate() {
			var u = this.target && this.target.usage;
			if (!u) return null;
			var cacheRead = u.cache_read || 0;
			if (!cacheRead) return null;
			var input = u.input || 0;
			var cacheWrite = u.cache_write || 0;
			var totalInput = input + cacheRead + cacheWrite;
			return totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0;
		}
	},
	created() {
		// Per-instance debounce to prevent line numbers from jumping during streaming
		this._applyLineNumbers = _.debounce(() => {
			if (!window.hljs) return;
			// First apply highlighting to blocks rendered before hljs loaded
			var allBlocks = this.$el.querySelectorAll('pre code');
			allBlocks.forEach(block => {
				if (!block.classList.contains('hljs') && window.hljs.highlightElement) {
					window.hljs.highlightElement(block);
				}
			});
			if (!window.hljs.lineNumbersBlock) return;
			var blocks = this.$el.querySelectorAll('pre code.hljs');
			blocks.forEach(block => {
				// Skip already processed blocks (hljs-line-numbers generates .hljs-ln table internally)
				if (block.querySelector('.hljs-ln')) return;
				window.hljs.lineNumbersBlock(block);
			});
		}, 400);
	},
	watch: {
		// Apply line numbers when streaming ends
		'target.loading'(val) {
			if (val === false) {
				this.$nextTick(() => this._applyLineNumbers());
			}
		},
		// Also apply on text change when not streaming (e.g. editing)
		'target.text'() {
			if (!this.target.loading) {
				this.$nextTick(() => this._applyLineNumbers());
			}
		}
	},
	mounted() {
		var anchors = this.$el.getElementsByTagName('a');
		for (var i = 0; i < anchors.length; i++) {
			anchors[i].setAttribute('target', '_blank');
		}
		// Apply line numbers for completed messages (history loaded)
		if (!this.target.loading) {
			this.$nextTick(() => this._applyLineNumbers());
		}
	},
	methods: {
		fmt(n, f) {
			return numeral(n).format(f);
		},
		marked,
		// Render any tool segment (args + events + result) as plain text so
		// the template doesn't have to branch on kind/phase. Walks the seg
		// generically: dump args as JSON, then for each event flatten its
		// fields (skip noisy/internal keys) into "key: value" lines, finally
		// append the result if present. Works for command/patch/anything
		// new the agent sends without template changes.
		format_tool_detail(seg) {
			if (!seg) return '';
			var lines = [];
			var skip = {
				kind: 1,
				name: 1,
				title: 1,
				phase: 1,
				itemId: 1,
				toolCallId: 1,
				ts: 1
			};
			// 1) args (skip when only one field — already shown as argsSummary)
			if (seg.args && typeof seg.args === 'object') {
				var argKeys = Object.keys(seg.args);
				if (argKeys.length > 1) {
					try {
						lines.push(JSON.stringify(seg.args, null, 2));
					} catch (e) {
						/* ignore */
					}
				}
			}
			// 2) events in time order
			var events = Array.isArray(seg.events) ? seg.events : [];
			events.forEach(function (ev) {
				if (!ev || typeof ev !== 'object') return;
				var head = ev.kind || 'event';
				var tail = [];
				Object.keys(ev).forEach(function (k) {
					if (skip[k]) return;
					var v = ev[k];
					if (v === undefined || v === null || v === '') return;
					if (Array.isArray(v)) {
						if (v.length === 0) return;
						tail.push(k + ': ' + v.join(', '));
					} else if (typeof v === 'object') {
						try {
							tail.push(k + ': ' + JSON.stringify(v));
						} catch (e) {
							/* ignore */
						}
					} else if (k === 'output' || (typeof v === 'string' && v.indexOf('\n') >= 0)) {
						// Multi-line values get their own block under the head.
						tail.push(k + ':\n' + String(v));
					} else {
						tail.push(k + '=' + v);
					}
				});
				if (tail.length === 0) {
					lines.push('· ' + head);
				} else {
					lines.push('· ' + head + ' ' + tail.join(' · '));
				}
			});
			// 3) result text (already markdown-friendly but we keep raw here)
			if (seg.result) {
				lines.push('');
				lines.push(String(seg.result));
			}
			return lines.join('\n');
		},
		copy_text() {
			var text = '';
			if (this.target && Array.isArray(this.target.segments) && this.target.segments.length > 0) {
				// Prefer joined text segments over the (possibly empty) flat text
				// field — agents on the new _patch protocol stream into segments.
				var parts = [];
				for (var i = 0; i < this.target.segments.length; i++) {
					var seg = this.target.segments[i];
					if (seg && seg.kind === 'text' && seg.text) parts.push(seg.text);
				}
				text = parts.join('\n\n');
			}
			if (!text && this.target) text = this.target.text || '';
			if (!text) return;
			var done = () => {
				this.copied = true;
				clearTimeout(this._copied_timer);
				this._copied_timer = setTimeout(() => {
					this.copied = false;
				}, 1500);
			};
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).then(done, () => this._fallback_copy(text, done));
			} else {
				this._fallback_copy(text, done);
			}
		},
		_fallback_copy(text, done) {
			try {
				var ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.left = '-9999px';
				document.body.appendChild(ta);
				ta.select();
				document.execCommand('copy');
				document.body.removeChild(ta);
				done && done();
			} catch (e) {
				console.error('copy failed', e);
			}
		}
	}
};
