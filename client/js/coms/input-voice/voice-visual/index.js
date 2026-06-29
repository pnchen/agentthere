export default {
	template: require('./index.html?raw'),
	props: {
		state: {
			type: String,
			default: 'off',
			validator(value) {
				return ['off', 'listening', 'active'].includes(value);
			}
		},
		loading: {
			type: Boolean,
			default: false
		},
		burst: {
			type: Boolean,
			default: false
		},
		size: {
			type: [Number, String],
			default: 40
		}
	},
	computed: {
		rootClass() {
			return {
				'is-off': this.state === 'off',
				'is-listening': this.state === 'listening',
				'is-active': this.state === 'active',
				'is-loading': this.loading,
				'is-burst': this.burst
			};
		},
		rootStyle() {
			const size = Number(this.size) || 40;
			return {
				'--voice-visual-size': `${size}px`
			};
		}
	}
};
