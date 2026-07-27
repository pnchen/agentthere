/**
 * Messaging mixin — DataChannel send / receive.
 */
import { Base64 } from 'js-base64';

const CHUNK_SIZE = 65536;
const DATA_CHANNEL_BUFFER_LIMIT = 256 * 1024;
const DATA_CHANNEL_DRAIN_TIMEOUT = 30_000;

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

		wait_for_datachannel_drain(datachannel) {
			if (!datachannel || datachannel.readyState !== 'open') {
				return Promise.reject(new Error('message DataChannel is not open'));
			}
			if (datachannel.bufferedAmount <= DATA_CHANNEL_BUFFER_LIMIT) return Promise.resolve();

			return new Promise((resolve, reject) => {
				var settled = false;
				var timer = null;
				var poll = null;
				var cleanup = () => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					if (poll) clearInterval(poll);
					datachannel.removeEventListener('bufferedamountlow', onLow);
					datachannel.removeEventListener('close', onClose);
					datachannel.removeEventListener('error', onError);
				};
				var finish = () => {
					if (datachannel.readyState === 'open' && datachannel.bufferedAmount <= DATA_CHANNEL_BUFFER_LIMIT) {
						cleanup();
						resolve();
					}
				};
				var onLow = () => finish();
				var onClose = () => {
					cleanup();
					reject(new Error('message DataChannel closed while draining'));
				};
				var onError = event => {
					cleanup();
					reject(event instanceof Error ? event : new Error('message DataChannel error while draining'));
				};

				datachannel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_LIMIT;
				datachannel.addEventListener('bufferedamountlow', onLow);
				datachannel.addEventListener('close', onClose, { once: true });
				datachannel.addEventListener('error', onError, { once: true });
				poll = setInterval(finish, 50);
				timer = setTimeout(() => {
					cleanup();
					reject(new Error(`message DataChannel drain timeout buffered=${datachannel.bufferedAmount}`));
				}, DATA_CHANNEL_DRAIN_TIMEOUT);
			});
		},

		send_message(message, { waitForDrain = false } = {}) {
			return this.retrieve_message_channel().then(async datachannel => {
				var payload = message;
				if (this.uid && this.remoteProfile?.agent) {
					payload = { ...message, uid: this.uid };
				}
				var encoded = JSON.stringify(payload);
				if (waitForDrain) await this.wait_for_datachannel_drain(datachannel);
				datachannel.send(encoded);
			});
		},

		send_file({ file, object_id }) {
			return Promise.resolve().then(() => {
				return new Promise((resolve, reject) => {
					const chunkSize = CHUNK_SIZE;
					var fileReader = new FileReader();
					console.log(`[rtc-peer:file] send start object_id=${object_id} name=${file.name} bytes=${file.size}`);
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
						return this.send_message({ object_id, chunk }, { waitForDrain: true })
							.then(() => {
								this.$emit('chunk-send', { remote_id: this.remoteId, object_id, size: e.target.result.byteLength });
								offset += e.target.result.byteLength;
								if (offset === e.target.result.byteLength || offset >= file.size || offset % (CHUNK_SIZE * 10) === 0) {
									console.log(`[rtc-peer:file] send progress object_id=${object_id} bytes=${offset}/${file.size}`);
								}
								if (offset < file.size) {
									readSlice(offset);
								} else {
									console.log(`[rtc-peer:file] send complete object_id=${object_id} bytes=${offset}`);
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
