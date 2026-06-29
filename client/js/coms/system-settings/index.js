import modal from 'js/mixins/modal.js';
import mqttShared from 'js/mixins/mqtt-shared.js';
import settings, { DEFAULTS, randomNamespace } from 'js/lib/settings';
import toastr from 'js/lib/toastr/toastr.js';
import template from './index.html?raw';

function iceTypeOf(s) {
	return s.urls && s.urls.startsWith('turn') ? 'turn' : 'stun';
}

export default {
	template,
	mixins: [modal, mqttShared],
	data() {
		var item_desc = JSON.stringify(settings);
		var item = JSON.parse(item_desc);

		return {
			item,
			item_desc,
			item_changed: false,
			iceTypes: item.ice_servers.map(s => iceTypeOf(s))
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

		this.$watch('item.theme', val => {
			document.documentElement.classList.toggle('skin-black', val === 'dark');
		});
	},
	computed: {
		darkMode: {
			get() {
				return this.item.theme === 'dark';
			},
			set(v) {
				this.item.theme = v ? 'dark' : 'light';
			}
		},
		brokerDisplayUrl() {
			return settings.signaling.url || '(not configured)';
		}
	},
	methods: {
		confirm() {
			return Promise.resolve()
				.then(() => {
					if (!this.item.signaling.url) {
						throw new Error('broker URL is required');
					}
					if (!this.item.signaling.namespace) {
						throw new Error('namespace is required');
					}
					var src = JSON.parse(JSON.stringify(this.item));
					Object.assign(settings.signaling, src.signaling);
					Object.assign(settings.vad, src.vad);
					settings.ice_servers.splice(0, settings.ice_servers.length, ...src.ice_servers);
					settings.theme = src.theme;
					this.dismiss('ok');
				})
				.catch(toastr.showError);
		},
		dismiss(msg) {
			if (msg === 'cancel') {
				document.documentElement.classList.toggle('skin-black', settings.theme === 'dark');
			}
			this.msg = msg;
			if (this.modal) this.modal.hide();
		},
		addIceServer() {
			this.item.ice_servers.push({ urls: '' });
			this.iceTypes.push('stun');
		},
		removeIceServer(i) {
			this.item.ice_servers.splice(i, 1);
			this.iceTypes.splice(i, 1);
		},
		onIceTypeChange(i) {
			if (this.iceTypes[i] === 'stun') {
				delete this.item.ice_servers[i].username;
				delete this.item.ice_servers[i].credential;
			}
		},
		randomNamespace() {
			this.item.signaling.namespace = randomNamespace();
		},
		resetIceServers() {
			var defaults = DEFAULTS.ice_servers.map(s => ({ ...s }));
			this.item.ice_servers.splice(0, this.item.ice_servers.length, ...defaults);
			this.iceTypes.splice(0, this.iceTypes.length, ...defaults.map(s => iceTypeOf(s)));
		}
	}
};
