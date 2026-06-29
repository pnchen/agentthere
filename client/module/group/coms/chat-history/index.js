import _ from 'underscore';
import moment from 'moment';
import messageStore from '../../lib/message-store';
import fileStore from '../../lib/file-store';
import store from 'store';

import modal from 'js/mixins/modal.js';
import chatMessage from '../chat-message/index.js';

export default {
	template: require('./index.html?raw'),
	components: {
		'chat-message': chatMessage
	},
	mixins: [modal],
	props: {
		group: { type: String, required: true },
		me: { type: Object, default: () => ({}) }
	},
	data() {
		return {
			db: null,
			date_selected: null,
			items: [],
			days: [],
			profile: {
				...store.get('profile')
			}
		};
	},
	watch: {
		date_selected(val) {
			if (val) {
				this.loadMessages(val);
			} else {
				this.items = [];
			}
		}
	},
	methods: {
		loadMessages(dateStr) {
			return Promise.resolve()
				.then(() => {
					if (!this.db || !this.group) throw new Error('db not ready');
					var dayStart = moment(dateStr).startOf('day').valueOf();
					var dayEnd = moment(dateStr).endOf('day').valueOf();
					return messageStore.listByGroupDateRange(this.db, this.group, dayStart, dayEnd);
				})
				.then(records => {
					var msgs = _.map(records, rec => {
						var payload = rec.payload || {};
						var msg = {
							...payload,
							date: moment(rec.createdAt),
							_persisted_pk: rec.pk,
							history: true
						};
						if (msg.loading && moment().diff(moment(rec.createdAt), 'hours') >= 1) {
							msg.loading = false;
							msg.status = null;
						}
						return msg;
					});
					msgs = _.sortBy(msgs, m => (m.date ? m.date.valueOf() : 0));
					this.items = msgs;
					return this._restoreFileUrls(msgs);
				})
				.catch(err => {
					console.warn('load day messages failed', err);
					this.items = [];
				});
		},
		_restoreFileUrls(messages) {
			if (!this.db || !messages || messages.length === 0) return Promise.resolve();
			var jobs = _.map(messages, msg => {
				if (!msg.file) return Promise.resolve();
				var fileId = msg.persisted_file_id || msg.object_id;
				if (!fileId) return Promise.resolve();
				if (msg.url && typeof msg.url === 'string' && msg.url.indexOf('blob:') === 0) {
					return Promise.resolve();
				}
				return fileStore.getFileBlob(this.db, fileId).then(blob => {
					if (!blob) return;
					var url = URL.createObjectURL(blob);
					msg.url = url;
				});
			});
			return Promise.all(jobs).catch(err => {
				console.warn('restore file URLs in chat-history failed', err);
			});
		}
	},
	mounted() {
		// 打开独立的 IndexedDB 连接
		if (messageStore.supportsIndexedDb()) {
			messageStore
				.openDb()
				.then(db => {
					this.db = db;
					return messageStore.listMessageDaysByGroup(db, this.group);
				})
				.then(days => {
					this.days = days || [];
				})
				.catch(err => {
					console.warn('chat-history: openDb failed', err);
				});
		}
	},
	beforeUnmount() {
		// Revoke any blob URLs we created
		_.each(this.items, msg => {
			if (msg.url && typeof msg.url === 'string' && msg.url.indexOf('blob:') === 0) {
				try {
					URL.revokeObjectURL(msg.url);
				} catch (e) {
					/* ignore */
				}
			}
		});
		// 关闭并销毁 IndexedDB 连接
		if (this.db) {
			try {
				this.db.close();
			} catch (e) {
				/* ignore */
			}
			this.db = null;
		}
	}
};
