import voiceVisual from './voice-visual';

export default {
	template: require('./index.html?raw'),
	components: {
		voiceVisual
	},
	props: {
		debug: { type: Boolean, default: false },
		keepalive_at: { type: [Number, String, Date], default: null },
		active_timeout_ms: { type: Number, default: 60000 }
	},
	watch: {
		keepalive_at(next, prev) {
			if (next === prev) return;
			if (this.state !== 'active') return;
			this._reset_active_timeout();
		},
		state(nextState, prevState) {
			if (nextState === prevState) return;
			if (nextState === 'off') {
				this._clear_active_burst();
				this._clear_active_timeout();
				if (this.stream) {
					this.stream.getTracks().forEach(t => t.stop());
					this.stream = null;
					this.$emit('stream-changed', null);
				}
				return;
			}
			if (nextState === 'active') {
				this._reset_active_timeout();
			}
			if (this.stream) {
				this.stream.getAudioTracks().forEach(t => {
					t.enabled = nextState === 'active';
				});
			}
		}
	},
	data() {
		return {
			// // 'off'    — not started
			// // 'active' — sending audio, track.enabled = true
			state: 'off',
			stream: null,
			error: null,
			loading: false,
			active_burst: false
		};
	},
	created() {
		this._timeout_timer = null;
		this._active_burst_timer = null;
	},
	beforeUnmount() {
		clearTimeout(this._timeout_timer);
		clearTimeout(this._active_burst_timer);
		if (this.stream) {
			this.stream.getTracks().forEach(t => t.stop());
			this.stream = null;
		}
	},
	methods: {
		toggle() {
			if (this.state === 'off') {
				this._start();
			} else {
				this.state = 'off';
			}
		},

		_clear_active_timeout() {
			clearTimeout(this._timeout_timer);
			this._timeout_timer = null;
		},

		_clear_active_burst() {
			clearTimeout(this._active_burst_timer);
			this._active_burst_timer = null;
			this.active_burst = false;
		},

		_play_active_burst() {
			this._clear_active_burst();
			this.$nextTick(() => {
				this.active_burst = true;
				this._active_burst_timer = setTimeout(() => {
					this.active_burst = false;
					this._active_burst_timer = null;
				}, 720);
			});
		},

		_reset_active_timeout() {
			this._clear_active_timeout();
			this._timeout_timer = setTimeout(() => {
				this.state = 'off';
			}, this.active_timeout_ms);
		},

		async _start() {
			if (this.loading) return;
			this.error = null;
			this.loading = true;

			try {
				if (!this.stream) {
					const stream = await navigator.mediaDevices.getUserMedia({
						audio: {
							channelCount: 1,
							echoCancellation: true,
							noiseSuppression: true,
							autoGainControl: true
						}
					});
					this.stream = stream;
					this.$emit('stream-changed', stream);
				}
				this.state = 'active';
				this.loading = false;
			} catch (err) {
				this.state = 'off';
				this.loading = false;
				this.error = err.message;
				console.error('input-voice _start failed', err);
			}
		}
	}
};
