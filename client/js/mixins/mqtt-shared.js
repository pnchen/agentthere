/**
 * Shared MQTT connection mixin — used by rtc-peer and rtc-group-signaling.
 *
 * Module-level factory + dedup cache; the mixin exposes mqtt_state via data().
 *
 *   state.connection — synced from mqtt client internal flags
 *   state.ready      — true after first successful connect
 *   state.unreachable— true when broker cannot be reached (banner trigger)
 *
 *   hashId(id) = SHA256(id).hex().slice(0, 12)
 *   Must match the agent-side hashId() output.
 */

import settings from 'js/lib/settings.js';
import { reactive } from 'vue';
import mqtt from 'mqtt';

var _client = null;
var _clientPromise = null;

export const mqtt_state = reactive({
	connection: 'disconnected',
	ready: false,
	unreachable: false
});

function _startLongRunning(client) {
	function syncState() {
		if (client.connected) mqtt_state.connection = 'connected';
		else if (client.reconnecting) mqtt_state.connection = 'reconnecting';
		else if (client.disconnecting) mqtt_state.connection = 'disconnected';
		else mqtt_state.connection = 'disconnected';
	}

	client.on('connect', () => {
		console.log('[mqtt-shared] connected to', settings.signaling.url);
		syncState();
	});
	client.on('close', () => {
		console.log('[mqtt-shared] connection closed');
		syncState();
	});
	client.on('reconnect', () => {
		console.log('[mqtt-shared] reconnecting');
		syncState();
	});
	client.on('offline', () => {
		console.log('[mqtt-shared] offline');
		syncState();
	});
	client.on('error', err => {
		console.error('[mqtt-shared] error', err);
		syncState();
	});

	syncState();
}

function createConnection({ will, clientId } = {}) {
	return new Promise((resolve, reject) => {
		if (!settings.signaling?.url) {
			mqtt_state.connection = 'disconnected';
			return reject(new Error('MQTT broker URL not configured'));
		}

		const opts = { keepalive: 120, clean: false };
		if (clientId) opts.clientId = clientId;
		if (will) opts.will = will;
		opts.transformWsUrl = (url, options, client) => {
			client.options.username = settings.signaling.username || undefined;
			client.options.password = settings.signaling.password || undefined;
			return settings.signaling.url;
		};
		const client = mqtt.connect(settings.signaling.url, opts);
		_client = client;
		mqtt_state.connection = 'connecting';

		client.once('connect', () => {
			console.log('[mqtt-shared] connected to', settings.signaling.url);
			mqtt_state.ready = true;
			resolve(client);
		});
		client.once('offline', () => {
			console.log('[mqtt-shared] connection offline (first attempt)');
			reject(new Error('Connection failed'));
		});
	});
}

function _destroyClient() {
	if (_client) {
		_client.removeAllListeners();
		_client.end(true);
		_client = null;
	}
	mqtt_state.connection = 'disconnected';
}

var retrieve_shared = ({ will, clientId } = {}) => {
	if (_clientPromise) return _clientPromise;

	_clientPromise = createConnection({ will, clientId })
		.then(client => {
			_startLongRunning(client);
			return client;
		})
		.catch(err => {
			_destroyClient();
			throw err;
		})
		.finally(() => {
			_clientPromise = null;
		});

	return _clientPromise;
};

export default {
	data() {
		return { mqtt_state };
	},
	computed: {
		mqtt_client() {
			return _client;
		}
	},
	methods: {
		retrieve_mqtt_client(opts = {}) {
			return retrieve_shared(opts);
		},

		reconnect_mqtt(opts = {}) {
			mqtt_state.ready = false;
			mqtt_state.unreachable = false;
			_destroyClient();
			_clientPromise = null;
			return this.retrieve_mqtt_client(opts).catch(err => {
				console.error('[mqtt-shared] reconnect_mqtt failed', err);
				mqtt_state.unreachable = true;
			});
		},

		ns(path) {
			return settings.signaling.namespace ? `${settings.signaling.namespace}/${path}` : path;
		},

		hashId(id) {
			return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(id))).then(buf =>
				Array.from(new Uint8Array(buf))
					.map(b => b.toString(16).padStart(2, '0'))
					.join('')
					.slice(0, 12)
			);
		}
	}
};
