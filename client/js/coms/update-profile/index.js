import modal from 'js/mixins/modal.js';
import settings from 'js/lib/settings';
import { Base64 } from 'js-base64';
import Avatar from 'vue-boring-avatars';
import nanoid from 'js/lib/nanoid';
import template from './index.html?raw';

export default {
	components: { Avatar },
	template,
	mixins: [modal],
	data() {
		var item_desc = JSON.stringify(settings);
		var item = JSON.parse(item_desc);
		return {
			item,
			item_desc,
			item_changed: false,
			variants: ['bauhaus', 'beam', 'pixel', 'marble', 'sunset', 'ring']
		};
	},
	created() {
		this.$watch(
			'item',
			val => {
				this.item_changed = JSON.stringify(val) !== this.item_desc;
			},
			{ deep: true }
		);

		this.$watch('item.profile.name', () => this.generate_avatar());
		this.$watch('item.profile.boring_avatar', () => this.generate_avatar(), { deep: true });

		if (this.item.profile.boring_avatar && !this.item.profile.boring_avatar.salt) {
			this.item.profile.boring_avatar.salt = nanoid();
		}
	},
	mounted() {
		if (!this.item.profile.avatar) {
			this.$nextTick(() => this.generate_avatar());
		}
	},
	computed: {},
	methods: {
		confirm() {
			var src = JSON.parse(JSON.stringify(this.item));
			Object.assign(settings.profile, src.profile);
			this.dismiss('ok');
		},
		dismiss(msg) {
			if (msg === 'cancel') {
				document.documentElement.classList.toggle('skin-black', settings.theme === 'dark');
			}
			this.msg = msg;
			if (this.modal) this.modal.hide();
		},
		random_salt() {
			this.item.profile.boring_avatar.salt = nanoid();
		},
		generate_avatar() {
			this.$nextTick(() => {
				if (!this.item.profile.name || !this.$refs.avatar) return;
				var svg = new XMLSerializer().serializeToString(this.$refs.avatar.$el);
				this.item.profile.avatar = `data:image/svg+xml;base64,${Base64.encode(svg)}`;
			});
		}
	}
};
