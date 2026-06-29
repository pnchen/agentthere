/**
 * Chat input history mixin
 * - Input history persistence (localStorage)
 * - Up/down arrow navigation through history
 */
import _ from 'underscore';
import store from 'store';

var KEY_INPUT_HISTORY = 'input_history';

export default {
	data() {
		return {
			input_history: [],
			input_history_pos: -1,
			input_history_current_text: null
		};
	},
	created() {
		this.input_history = store.get(KEY_INPUT_HISTORY) || [];
		var delay_save_input_history = _.debounce(() => {
			store.set(KEY_INPUT_HISTORY, this.input_history);
		}, 1000);
		this.$watch(
			'input_history',
			val => {
				delay_save_input_history();
			},
			{ deep: true }
		);
	},
	methods: {
		add_to_input_history(text) {
			this.input_history.unshift(text);
			if (this.input_history.length > 20) {
				this.input_history.pop();
			}
			this.input_history_pos = -1;
		},
		to_pre_input_history() {
			if (this.input_history_pos == -1) {
				this.input_history_current_text = this.params.text;
			}
			this.input_history_pos++;
			if (this.input_history_pos >= this.input_history.length) {
				this.input_history_pos = this.input_history.length - 1;
			}
			if (this.input_history_pos == -1) {
				this.params.text = this.input_history_current_text;
			} else {
				this.params.text = this.input_history[this.input_history_pos];
			}
		},
		to_next_input_history() {
			if (this.input_history_pos == -1) {
				return;
			}
			this.input_history_pos--;
			if (this.input_history_pos == -1) {
				this.params.text = this.input_history_current_text;
			} else {
				this.params.text = this.input_history[this.input_history_pos];
			}
		}
	}
};
