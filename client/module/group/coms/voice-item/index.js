export default {
	data() {
		return {
			object_url: null,
			voice_playing: false,
			voice_duration: ''
		};
	},
	props: ['file', 'url', 'autoplay'],
	template: require('./index.html?raw'),
	computed: {
		src() {
			return this.url || this.object_url || '';
		}
	},
	created() {
		this.$watch('file', () => this.parse(), { deep: true });
		this.parse();
	},
	unmounted() {
		this.clear_object_url();
	},
	methods: {
		clear_object_url() {
			if (this.object_url) {
				URL.revokeObjectURL(this.object_url);
				this.object_url = null;
			}
		},
		parse() {
			this.clear_object_url();
			if (!this.url && this.file instanceof Blob) {
				this.object_url = URL.createObjectURL(this.file);
			}
		},
		// Single click toggles play/pause on the hidden <audio>. Visual state
		// lives in voice_playing and is driven by play/pause/ended events so
		// external pauses (from another bubble's exclusive-play logic) still
		// flip the icon back to ▶.
		toggle() {
			var audio = this.$refs.audio;
			if (!audio) return;
			if (audio.paused) {
				try {
					audio.play();
				} catch (e) {
					// ignore — gesture / src not ready
				}
			} else {
				audio.pause();
			}
		},
		// Exclusive playback: when this voice clip starts, pause every other
		// <audio>/<video> on the page so newer voice messages naturally
		// override older ones.
		pause_other_media(current) {
			if (!current) return;
			var nodes = document.querySelectorAll('audio, video');
			for (var i = 0; i < nodes.length; i++) {
				var el = nodes[i];
				if (el === current) continue;
				if (!el.paused) {
					try {
						el.pause();
					} catch (e) {
						// ignore
					}
				}
			}
		},
		on_play(ev) {
			this.voice_playing = true;
			this.pause_other_media(ev && ev.target);
		},
		on_pause() {
			this.voice_playing = false;
		},
		on_ended() {
			this.voice_playing = false;
		},
		on_meta(ev) {
			var d = ev && ev.target && ev.target.duration;
			if (d && isFinite(d)) {
				this.voice_duration = this._fmt_time(d);
			}
		},
		_fmt_time(sec) {
			sec = Math.max(0, Math.floor(sec));
			var m = Math.floor(sec / 60);
			var s = sec % 60;
			return m + ':' + (s < 10 ? '0' + s : s);
		}
	}
};
