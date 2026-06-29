import { Modal } from 'bootstrap';

export default {
	emits: ['ok', 'cancel'],
	mounted() {
		this.modal = Modal.getOrCreateInstance(this.$el);
		this.onHidden = evt => {
			if (document.querySelectorAll('.modal.show').length) {
				document.body.classList.add('modal-open');
			}
			if (evt.target != this.$el) {
				return;
			}
			this.$emit(this.msg == 'ok' ? 'ok' : 'cancel', this.item);
		};

		this.$el.addEventListener('hidden.bs.modal', this.onHidden);
		this.modal.show();
	},
	methods: {
		dismiss(msg) {
			this.msg = msg;
			if (this.modal) {
				try { this.modal.hide(); } catch (e) { /* disposed concurrently */ }
			}
		}
	},
	beforeUnmount() {
		if (this.onHidden) {
			this.$el.removeEventListener('hidden.bs.modal', this.onHidden);
		}
		if (this.modal) {
			// If the modal is mid-transition, skip dispose to avoid
			// Bootstrap's async callback crashing on a null _element.
			if (!this.modal._isTransitioning) {
				this.modal.dispose();
			}
			this.modal = null;
		}
	}
};
