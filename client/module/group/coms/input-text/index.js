import _ from 'underscore';

export default {
	template: require('./index.html?raw'),
	emits: [
		'update:modelValue',
		'input',
		'commit',
		'up',
		'down',
		'mention-up',
		'mention-down',
		'mention-select',
		'mention-cancel',
		'control-up',
		'control-down',
		'control-select',
		'control-cancel'
	],
	props: {
		modelValue: {
			type: [String, Number],
			default: ''
		},
		mentionActive: {
			type: Boolean,
			default: false
		},
		controlActive: {
			type: Boolean,
			default: false
		},
		autosize: {
			type: Boolean,
			default: true
		},
		minHeight: {
			type: [Number],
			default: null
		},
		maxHeight: {
			type: [Number],
			default: null
		},
		/*
		 * Force !important for style properties
		 */
		important: {
			type: [Boolean, Array],
			default: false
		}
	},
	data() {
		return {
			// data property for v-model binding with real textarea tag
			val: null,
			// works when content height becomes more then value of the maxHeight property
			maxHeightScroll: false,
			height: 'auto'
		};
	},
	computed: {
		computedStyles() {
			if (!this.autosize) return {};
			return {
				resize: !this.isResizeImportant ? 'none' : 'none !important',
				height: this.height,
				overflow: this.maxHeightScroll ? 'auto' : !this.isOverflowImportant ? 'hidden' : 'hidden !important'
			};
		},
		isResizeImportant() {
			const imp = this.important;
			return imp === true || (Array.isArray(imp) && imp.includes('resize'));
		},
		isOverflowImportant() {
			const imp = this.important;
			return imp === true || (Array.isArray(imp) && imp.includes('overflow'));
		},
		isHeightImportant() {
			const imp = this.important;
			return imp === true || (Array.isArray(imp) && imp.includes('height'));
		}
	},
	watch: {
		// Vue 3: v-model binds to modelValue
		modelValue(val) {
			if (val !== this.val) this.val = val;
		},
		val(val) {
			this.$nextTick(this.resize);
			this.$emit('update:modelValue', val);
			this.$emit('input', val);
		},
		minHeight() {
			this.$nextTick(this.resize);
		},
		maxHeight() {
			this.$nextTick(this.resize);
		},
		autosize(val) {
			if (val) this.resize();
		}
	},
	methods: {
		resize() {
			const important = this.isHeightImportant ? 'important' : '';
			this.height = `auto${important ? ' !important' : ''}`;
			this.$nextTick(() => {
				let contentHeight = this.$el.scrollHeight + 1;

				if (this.minHeight) {
					contentHeight = contentHeight < this.minHeight ? this.minHeight : contentHeight;
				}

				if (this.maxHeight) {
					if (contentHeight > this.maxHeight) {
						contentHeight = this.maxHeight;
						this.maxHeightScroll = true;
					} else {
						this.maxHeightScroll = false;
					}
				}

				const heightVal = contentHeight + 'px';
				this.height = `${heightVal}${important ? ' !important' : ''}`;
			});

			return this;
		},
		on_keydown(event) {
			if (this.controlActive) {
				if (event.key === 'ArrowUp') {
					event.preventDefault();
					this.$emit('control-up');
					return;
				}
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					this.$emit('control-down');
					return;
				}
				if (event.key === 'Enter' || event.key === 'Tab') {
					event.preventDefault();
					this.$emit('control-select');
					return;
				}
				if (event.key === 'Escape') {
					event.preventDefault();
					this.$emit('control-cancel');
					return;
				}
			}
			if (this.mentionActive) {
				if (event.key === 'ArrowUp') {
					event.preventDefault();
					this.$emit('mention-up');
					return;
				}
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					this.$emit('mention-down');
					return;
				}
				if (event.key === 'Enter' || event.key === 'Tab') {
					event.preventDefault();
					this.$emit('mention-select');
					return;
				}
				if (event.key === 'Escape') {
					event.preventDefault();
					this.$emit('mention-cancel');
					return;
				}
			}
			if (event.key === 'Enter') {
				this.on_enter(event);
			}
			if (event.key === 'ArrowUp') {
				this.on_up(event);
			}
			if (event.key === 'ArrowDown') {
				this.on_down(event);
			}
		},
		on_keyup(event) {
			if (this.controlActive || this.mentionActive) return;
		},
		on_enter(event) {
			console.log(event);
			if (event.shiftKey) {
				return;
			}
			event.preventDefault();

			var current = this.val;
			if (current && String(current).trim().length > 0) {
				this.$emit('commit');
			}
		},
		on_up(event) {
			// Only switch history up when cursor is at the very start (and no selection)
			var el = this.$el;
			if (!el) return;
			if (el.selectionStart !== 0 || el.selectionEnd !== 0) {
				return;
			}
			event.preventDefault();
			this.$emit('up');
		},
		on_down(event) {
			// Only switch history down when cursor is at the very end (and no selection)
			var el = this.$el;
			if (!el) return;
			var end = (el.value || '').length;
			if (el.selectionStart !== end || el.selectionEnd !== end) {
				return;
			}
			event.preventDefault();
			this.$emit('down');
		},
		insert_text(text, { block, cursor } = {}) {
			var cur = this.$el.selectionStart;
			if (!_.isUndefined(cursor)) {
				cur += cursor;
			} else {
				cur += text.length;
			}
			if (block) {
				if (this.$el.selectionStart != 0) {
					text = '\n' + text;
					cur += 1;
				}
				if (this.$el.selectionEnd < this.$el.value.length) {
					text = text + '\n';
				}
			}

			this.$el.setRangeText(text, this.$el.selectionStart, this.$el.selectionEnd);
			// Sync internal reactive val — val watcher will emit "input" to parent
			// Avoid race between direct $emit and val watcher
			this.val = this.$el.value;

			this.$el.focus();

			// Vue may patch textarea in the next tick; setting cursor after patch is more reliable
			this.$nextTick(() => {
				this.$el.setSelectionRange(cur, cur);
			});
		},
		insert_code_block() {
			var text = this.$el.value || '';
			var start = this.$el.selectionStart;
			// Count how many standalone triple-backtick fences exist before the cursor
			// Odd = cursor is inside a code block, just focus
			var before = text.substring(0, start);
			var fenceCount = (before.match(/^```/gm) || []).length;
			if (fenceCount % 2 === 1) {
				this.$el.focus();
				return;
			}
			this.insert_text('```\n\n```', { block: true, cursor: 4 });
		}
	},
	created() {
		this.val = this.modelValue;
	},
	mounted() {
		this.resize();
	}
};
