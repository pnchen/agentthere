import settings from 'js/lib/settings';
import { Base64 } from 'js-base64';
import Avatar from 'vue-boring-avatars';
import nanoid from 'js/lib/nanoid';
import systemSettings from 'js/coms/system-settings/index.js';
import updateProfile from 'js/coms/update-profile/index.js';

export default {
	template: require('./index.html?raw'),
	components: {
		Avatar,
		'system-settings': systemSettings,
		'update-profile': updateProfile
	},
	data() {
		return {
			settings,
			params: {
				channel: null,
				settings_open: false,
				profile_open: false
			},
			variants: ['bauhaus', 'beam', 'pixel', 'marble', 'sunset', 'ring']
		};
	},
	created() {
		if (!settings.profile.boring_avatar.salt) {
			settings.profile.boring_avatar.salt = nanoid();
		}
	},
	methods: {
		random_salt() {
			settings.profile.boring_avatar.salt = nanoid();
		},
		generate_avatar() {
			this.$nextTick(() => {
				if (!settings.profile.name || !this.$refs.avatar) return;
				var svg = new XMLSerializer().serializeToString(this.$refs.avatar.$el);
				settings.profile.avatar = `data:image/svg+xml;base64,${Base64.encode(svg)}`;
			});
		}
	}
};
