import mime from 'mime';
import mimetypeToFontawesome from 'mimetype-to-fontawesome';
var mimetype2fa = mimetypeToFontawesome({ prefix: 'fa-' });
export default {
	data() {
		return {
			icon_fa: null,
			mimetype: null,
			object_url: null
		};
	},
	computed: {},
	props: ['file', 'url', 'autoplay'],
	template: require('./index.html?raw'),
	created() {
		this.$watch(
			'file',
			val => {
				this.parse();
			},
			{ deep: true }
		);
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
			var ext = this.file ? this.file.name.split('.').pop().toLowerCase() : '';
			var mimetype = ext ? mime.getType(ext) : '';
			// Force .opus → audio/ogg (Ogg-Opus container). Some `mime` package
			// versions return audio/opus, which several browsers refuse to play
			// via <audio>. audio/ogg is the canonical container mime that
			// Chrome/Firefox/Safari all decode for Opus payloads.
			if (ext === 'opus') {
				mimetype = 'audio/ogg';
			}
			var icon_fa = mimetype ? mimetype2fa(mimetype) : 'fa-file';
			this.mimetype = mimetype || '';
			this.icon_fa = icon_fa;
			if (!this.url && this.file instanceof Blob) {
				this.object_url = URL.createObjectURL(this.file);
			}
		},
		// When this audio/video starts playing (autoplay or user action),
		// pause every other <audio>/<video> element on the page so playback
		// is exclusive — newer voice messages naturally override older ones,
		// and tapping play on any clip stops whatever is currently playing.
		on_media_play(ev) {
			var current = ev && ev.target;
			if (!current) return;
			var nodes = document.querySelectorAll('audio, video');
			for (var i = 0; i < nodes.length; i++) {
				var el = nodes[i];
				if (el === current) continue;
				if (!el.paused) {
					try {
						el.pause();
					} catch (e) {
						// ignore — element may have been removed mid-iteration
					}
				}
			}
		}
	}
};
