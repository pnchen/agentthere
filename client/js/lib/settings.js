import { reactive, watch } from 'vue';
import store from 'store';

var KEY = 'user_settings';

var DEFAULTS = {
	profile: {
		name: '',
		avatar: null,
		boring_avatar: {
			variant: 'beam',
			salt: null,
			colors: ['#b57353', '#f1731f'],
			size: 120
		}
	},
	vad: {
		enabled: true,
		positive_speech_threshold: 0.4,
		negative_speech_threshold: 0.16,
		redemption_ms: 1200,
		pre_speech_pad_ms: 600,
		min_speech_ms: 220,
		open_delay_ms: 500
	},
	theme: 'light',
	/**
	 * MQTT topic namespace — shared secret between agent and all browser peers.
	 * Leave empty to use hash-only topics (no cross-deployment isolation).
	 * Must match channels.agentthere.mqtt.namespace on the agent side.
	 */
	signaling: {
		url: '',
		username: '',
		password: '',
		namespace: ''
	},
	ice_servers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
};

// Merge saved state into defaults
var saved = store.get(KEY) || {};
var raw = { ...DEFAULTS, ...saved };

var settings = reactive(raw);

watch(
	function () {
		return JSON.parse(JSON.stringify(settings));
	},
	function (val) {
		store.set(KEY, val);
	},
	{ deep: true }
);

/** Generate a random namespace string (13-char alphanumeric). */
export function randomNamespace() {
	return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 13);
}

// Migrate legacy profile from separate store key into settings
var legacyProfile = store.get('profile');
if (legacyProfile) {
	Object.assign(settings.profile, legacyProfile);
	store.remove('profile');
}

export default settings;
export { DEFAULTS };
