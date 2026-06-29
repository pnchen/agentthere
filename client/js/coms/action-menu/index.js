import { Dropdown } from 'bootstrap';
import { Comment, Fragment } from 'vue';

function hasSlotContent(slot) {
	if (!slot) return false;
	return slot().some(vnode => {
		if (vnode.type === Comment) return false;
		if (vnode.type === Fragment) return vnode.children && vnode.children.length > 0;
		return true;
	});
}

export default {
	template: require('./index.html?raw'),
	computed: {
		toggle_btn_size() {
			return this.size ? `btn-${this.size}` : '';
		},
		hasContent() {
			return hasSlotContent(this.$slots.default);
		}
	},
	props: ['size'],
	mounted() {
		if (!this.$el || typeof this.$el.querySelectorAll !== 'function') {
			return;
		}

		this.$el.querySelectorAll('[data-bs-toggle=dropdown]').forEach(el => {
			Dropdown.getOrCreateInstance(el);
		});
	}
};
