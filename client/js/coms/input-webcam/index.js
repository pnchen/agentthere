import _ from 'underscore';
import qs from 'qs';
import toastr from 'js/lib/toastr/toastr.js';

import inputWebcam from './input-webcam/index.js';

export default {
	components: {
		'input-webcam': inputWebcam
	},
	template: require('./index.html?raw'),
	data() {
		return {
			constraints: {
				display: this.display || false,
				video: this.video || false,
				audio: this.audio || false,
				webcam: this.webcam || null
			},
			stream_user: null,
			stream_display: null,
			stream_webcam: null,
			devices_videoinput: [],
			devices_audioinput: []
		};
	},
	props: ['video', 'audio', 'preview', 'webcam'],
	beforeUnmount() {
		this.clear_listen();
	},
	created() {
		this.enumerate_devices();
		navigator.mediaDevices.ondevicechange = event => {
			this.enumerate_devices();
		};
	},
	mounted() {
		this.$watch('video', val => {
			this.constraints.video = this.video;
		});
		this.$watch('audio', val => {
			this.constraints.audio = this.audio;
		});
		this.$watch('constraints.display', val => {
			if (this.constraints.display) {
				this.constraints.video = false;
				this.constraints.webcam = null;
			}
			return this.init_display_media().catch(err => {
				toastr.showError(err);
				this.constraints.display = false;
			});
		});

		this.$watch('constraints.webcam', val => {
			if (this.constraints.webcam) {
				this.constraints.display = false;
				this.constraints.video = false;
			}
			if (this.stream_webcam) {
				this.stream_webcam.getTracks().forEach(track => track.stop());
				this.stream_webcam = null;
			}
		});

		this.$watch('constraints.video', () => {
			if (this.constraints.video) {
				this.constraints.display = false;
				this.constraints.webcam = null;
			}
			return this.init_user_media().catch(err => {
				toastr.showError(err);
				this.constraints.video = false;
			});
		});
		this.$watch('constraints.audio', () => {
			return this.init_user_media().catch(err => {
				toastr.showError(err);
				this.constraints.audio = false;
			});
		});

		this.$watch('stream_user', () => {
			this.debounce_notify();
		});
		this.$watch('stream_display', () => {
			this.debounce_notify();
		});
		this.$watch('stream_webcam', () => {
			this.debounce_notify();
		});
		this.debounce_notify = _.debounce(() => {
			var streams = [];
			if (this.stream_user) {
				streams.push(this.stream_user);
			}
			if (this.stream_display) {
				streams.push(this.stream_display);
			}
			if (this.stream_webcam) {
				streams.push(this.stream_webcam);
			}
			this.$emit('stream-changed', streams);
		}, 300);

		this.constraints.webcam = this.webcam || null;
		this.$watch('webcam', val => {
			this.constraints.webcam = this.webcam;
		});
	},
	methods: {
		clear_listen() {
			// Clean up all streams
			if (this.stream_user) {
				this.stream_user.getTracks().forEach(track => track.stop());
				this.stream_user = null;
			}
			if (this.stream_display) {
				this.stream_display.getTracks().forEach(track => track.stop());
				this.stream_display = null;
			}
			if (this.stream_webcam) {
				this.stream_webcam.getTracks().forEach(track => track.stop());
				this.stream_webcam = null;
			}
		},
		is_device_qeual(d1, d2) {
			if (d1 && d2) {
				console.log(d1.deviceId, d2.deviceId);
			}
			if (d1 && d2 && d1.deviceId == d2.deviceId) {
				console.log('is_device_qeual true');

				return true;
			}
			console.log('is_device_qeual false');

			return false;
		},
		enumerate_devices() {
			return navigator.mediaDevices.enumerateDevices().then(devices => {
				this.devices_videoinput = _.filter(devices, device => {
					return device.kind == 'videoinput';
				});
				_.each(this.devices_videoinput, d => {
					d.device_id = d.deviceId;
				});
				this.devices_audioinput = _.filter(devices, device => {
					// console.log(device.kind + ': ' + device.label + ' id = ' + device.deviceId);
					return device.kind == 'audioinput';
				});
				_.each(this.devices_audioinput, d => {
					d.device_id = d.deviceId;
				});
			});
		},
		init_user_media() {
			return Promise.resolve()
				.then(() => {
					if (this.stream_user) {
						_.each(this.stream_user.getTracks(), track => {
							track.stop();
						});
						this.stream_user = null;
					}
				})
				.then(() => {
					if (this.constraints.video || this.constraints.audio) {
						var video = this.constraints.video ? true : false;
						if (video && this.constraints.video?.deviceId) {
							video = {
								deviceId: { exact: this.constraints.video.deviceId }
							};
						}
						var audio = this.constraints.audio ? true : false;
						if (audio && this.constraints.audio.deviceId) {
							audio = {
								deviceId: { exact: this.constraints.audio.deviceId }
							};
						}
						return navigator.mediaDevices.getUserMedia({ video, audio }).then(stream => {
							this.stream_user = stream;
						});
					}
				});
		},
		init_display_media() {
			return Promise.resolve()
				.then(() => {
					if (this.stream_display) {
						_.each(this.stream_display.getTracks(), track => {
							track.stop();
						});
						this.stream_display = null;
					}
				})
				.then(() => {
					if (this.constraints.display) {
						return navigator.mediaDevices.getDisplayMedia({}).then(stream => {
							this.stream_display = stream;
						});
					}
				});
		},

		select_file() {
			console.log(this.$refs['input-file']);
			this.$refs['input-file'].click();
		},
		on_select_file(event) {
			this.$emit('select-file', event.target.files);
		}
	}
};
