import _ from 'underscore';
import qs from 'qs';

export default {
	template: require('./index.html?raw'),
	data() {
		return {
			context: null,
			img: null,
			camera_render_interval: null,
			fps: 30 // Frame rate
		};
	},
	props: ['url'],
	beforeUnmount() {
		console.log('beforeDestroy clear listen');
		if (this.camera_render_interval) {
			clearInterval(this.camera_render_interval);
			this.camera_render_interval = null;
		}
		this.img.onload = null;
		this.img.onerror = null;
		this.img.src = null;
		this.img = null;
		this.context = null;
	},
	created() {},
	mounted() {
		this.context = this.$el.getContext('2d');
		// Get the canvas MediaStream

		// Create an img element to load the MJPEG stream
		this.img = new Image();
		this.img.crossOrigin = 'anonymous';

		// Set canvas dimensions

		this.img.onload = () => {
			console.log('Camera image loaded successfully');
			console.log(this.img.width, this.img.height);
			this.$el.width = this.img.width;
			this.$el.height = this.img.height;
			this.$emit('input', this.$el.captureStream(this.fps));
			this.start_camera_render();
		};

		this.img.onerror = error => {
			this.$emit('error', new Error(`Camera image load error, ${error.message || 'Unknown error'}`));
			console.error('Camera image load error:', error);
		};

		// Load MJPEG stream — img auto-updates since it is MJPEG
		this.img.src = this.url;
	},
	methods: {
		clear_camera_media() {
			// Clean up camera resources
		},

		start_camera_render() {
			if (this.camera_render_interval) {
				clearInterval(this.camera_render_interval);
				this.camera_render_interval = null;
			}
			this.camera_render_interval = setInterval(() => {
				if (this.img && this.context) {
					try {
						this.context.drawImage(this.img, 0, 0, this.$el.width, this.$el.height);
					} catch (error) {
						console.warn('Camera render error:', error);
					}
				}
			}, 1000 / this.fps); // 30 FPS
		}
	}
};
