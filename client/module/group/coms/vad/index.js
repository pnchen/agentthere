import _ from 'underscore';
import create_vad_stream from './vad-lib';
import template from './index.html?raw';

export default {
	template,
	props: {
		streamSource: { type: [MediaStream, Object], default: null },
		settings: { type: Object, default: () => ({}) }
	},
	emits: ['stream-change'],
	data() {
		return {
			status: {
				phase: 'off',
				gateOpen: false,
				speechProb: null,
				error: null
			}
		};
	},
	created() {
		this._controller = null;
		this._seq = 0;
		this.$watch(
			'streamSource',
			stream => {
				this.sync(stream);
			},
			{ immediate: true }
		);
		this.$watch(
			'settings',
			() => {
				if (this._controller && this._controller.vad && this._controller.vad.setOptions) {
					this._controller.vad.setOptions(this.vadOptions);
				}
			},
			{ deep: true }
		);
	},
	beforeUnmount() {
		this.dispose();
	},
	methods: {
		sync(stream) {
			var seq = ++this._seq;
			if (this._controller) {
				this._controller.destroy();
				this._controller = null;
			}
			this.$emit('stream-change', null);
			if (!stream) {
				this.status = { phase: 'off', gateOpen: false, speechProb: null, error: null };
				return;
			}
			this.status = { phase: 'loading', gateOpen: false, speechProb: null, error: null };
			create_vad_stream(stream, {
				onStatus: st => {
					if (seq !== this._seq) return;
					this.status = { ...this.status, ...st };
				},
				vadOptions: this.vadOptions
			})
				.then(controller => {
					if (seq !== this._seq) {
						if (controller) controller.destroy();
						return;
					}
					this._controller = controller;
					var out = controller ? controller.stream : stream;
					if (out) out.vad_applied = true;
					this.$emit('stream-change', out);
					if (controller) controller.start();
				})
				.catch(err => {
					console.warn('vad failed', err);
					if (seq !== this._seq) return;
					this.$emit('stream-change', stream);
					var msg = err && err.message ? err.message : String(err || '');
					msg = msg.trim().slice(0, 72);
					this.status = { phase: 'fallback', gateOpen: true, speechProb: null, error: msg || null };
				});
		},
		dispose() {
			this._seq += 1;
			if (this._controller) {
				this._controller.destroy();
				this._controller = null;
			}
			this.status = { phase: 'off', gateOpen: false, speechProb: null, error: null };
		}
	},
	computed: {
		vadOptions() {
			return {
				positiveSpeechThreshold: this.settings.positive_speech_threshold ?? 0.55,
				negativeSpeechThreshold: this.settings.negative_speech_threshold ?? 0.16,
				redemptionMs: this.settings.redemption_ms ?? 1200,
				preSpeechPadMs: this.settings.pre_speech_pad_ms ?? 400,
				minSpeechMs: this.settings.min_speech_ms ?? 220,
				openDelayMs: this.settings.open_delay_ms
			};
		},
		badgeClass() {
			var s = this.status || {};
			if (s.phase === 'error') return 'text-bg-danger';
			if (s.phase === 'fallback') return 'text-bg-warning';
			if (s.gateOpen) return 'text-bg-success';
			if (s.phase === 'loading' || s.phase === 'init') return 'text-bg-secondary';
			if (s.phase === 'off') return 'text-bg-light';
			return 'text-bg-dark';
		},
		badgeText() {
			var s = this.status || {};
			if (s.phase === 'loading' || s.phase === 'init') return '⋯';
			if (s.phase === 'fallback') return '⚡';
			if (s.phase === 'error') return '✕';
			if (s.phase === 'paused') return '⏸';
			if (s.phase === 'no-audio') return '∅';
			if (s.gateOpen) return '◉';
			if (s.phase === 'listening' || s.phase === 'ready') return '○';
			return '⊗';
		},
		speechPercent() {
			var v = this.status && _.isNumber(this.status.speechProb) ? this.status.speechProb : 0;
			return Math.round(v * 100);
		}
	}
};
