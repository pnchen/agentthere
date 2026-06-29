import axios from 'axios';
import confirm from 'js/lib/confirm.js';
import modal from 'js/mixins/modal.js';
import _ from 'underscore';
import nativeFileItem from '../native-file-item/index.js';

export default {
	components: {
		'native-file-item': nativeFileItem
	},
	template: require('./index.html?raw'),
	mixins: [modal],
	data() {
		var item_desc = JSON.stringify({});

		return {
			files: _.isArray(this.target) ? this.target : [this.target]
		};
	},
	props: ['target'],
	created() {
		this.$watch('target', val => {
			this.files = _.isArray(this.target) ? this.target : [this.target];
		});
	},
	methods: {
		confirm() {
			this.dismiss('ok');
		}
	}
};
