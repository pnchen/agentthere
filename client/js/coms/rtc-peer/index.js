import mqttShared from 'js/mixins/mqtt-shared.js';
import signaling from './signaling.js';
import messaging from './messaging.js';
import connection from './connection.js';
import media from './media.js';

export default {
	template: require('./index.html?raw'),
	mixins: [mqttShared, signaling, messaging, connection, media],
	props: ['peer-id', 'remote-id', 'peer-profile', 'remote-profile', 'local-streams', 'group', 'uid'],
	computed: {
		offerer() {
			return this.peerId > this.remoteId;
		}
	},
	async created() {
		await this.setup_signaling();
		this._connect_loop();

		this.$watch('localStreams', val => {
			console.log('on local streams');
			this.add_local_tracks();
		});
	}
};
