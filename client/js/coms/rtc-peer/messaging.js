/**
 * Messaging mixin — DataChannel send / receive.
 */
import { Base64 } from 'js-base64';

const CHUNK_SIZE = 65536;

export default {
	data() {
		return {
			datachannel_message: null
		};
	},
	methods: {
		retrieve_message_channel() {
			return new Promise((resolve, reject) => {
				if (this.datachannel_message && this.datachannel_message.readyState == 'open') {
					return resolve(this.datachannel_message);
				}
				if (!this.datachannel_message || this.datachannel_message.readyState != 'connecting') {
					this.datachannel_message = this.pc.createDataChannel(`message`);
				}

				var ch = this.datachannel_message;
				ch.addEventListener('open', () => resolve(ch), { once: true });
				ch.addEventListener(
					'error',
					err => {
						console.log('message datachannel, error', err);
						reject(err);
					},
					{ once: true }
				);
			});
		},

		on_datachannel_message({ data }) {
			var message = JSON.parse(data);
			this.$emit('message', { ...message, from: this.remoteProfile });
		},

		send_profile() {
			console.log('sending profile');
			this.send_message({
				type: 'profile',
				profile: this.peerProfile,
				uid: this.remoteProfile?.agent ? this.uid : undefined
			});
		},

		send_message(message) {
			return this.retrieve_message_channel().then(datachannel => {
				var payload = message;
				if (this.uid && this.remoteProfile?.agent) {
					payload = { ...message, uid: this.uid };
				}
				datachannel.send(JSON.stringify(payload));
			});
		},

		send_file({ file, object_id }) {
			return Promise.resolve().then(() => {
				return new Promise((resolve, reject) => {
					const chunkSize = CHUNK_SIZE;
					var fileReader = new FileReader();
					const readSlice = o => {
						const slice = file.slice(offset, o + chunkSize);
						fileReader.readAsArrayBuffer(slice);
					};
					let offset = 0;
					fileReader.addEventListener('error', error => console.error('Error reading file:', error));
					fileReader.addEventListener('abort', event => console.log('File reading aborted:', event));
					fileReader.addEventListener('load', e => {
						var chunk = {
							object_id,
							offset,
							data: Base64.fromUint8Array(new Uint8Array(e.target.result))
						};
						return this.send_message({ object_id, chunk })
							.then(() => {
								this.$emit('chunk-send', { remote_id: this.remoteId, object_id, size: e.target.result.byteLength });
								offset += e.target.result.byteLength;
								if (offset < file.size) {
									readSlice(offset);
								} else {
									resolve();
								}
							})
							.catch(error => {
								console.log(error);
								console.log('retry after 100ms');
								setTimeout(() => readSlice(offset), 100);
							});
					});
					readSlice(0);
				});
			});
		}
	}
};
