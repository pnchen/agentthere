import _ from 'underscore';

export default {
	template: require('./index.html?raw'),
	data() {
		return {};
	},
	props: ['stream'],
	mounted() {
		this.$watch('stream', newStream => {
			this.play();
		});
		this.play();
	},
	methods: {
		play() {
			this.$el.srcObject = this.stream;
		}
	}
};
