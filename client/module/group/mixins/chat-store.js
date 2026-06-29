/**
 * Chat store mixin
 * - IndexedDB message persistence (init, load, upsert)
 * - File/blob storage (save, restore, cleanup)
 * - Storage management (clear, keep_recent, summary)
 */
import _ from 'underscore';
import moment from 'moment';
import messageStore from '../lib/message-store';
import fileStore from '../lib/file-store';

var PAGE_SIZE = 50;

export default {
	data() {
		return {
			hasMoreMessages: false
		};
	},
	created() {
		this._object_urls = [];
		this._message_db = null;
		this._persist_message_debouncers = {};

		this.$watch('group', val => {
			this.load_messages_from_store();
		});

		this.init_message_store();
	},
	beforeUnmount() {
		this.release_all_object_urls();
		// Close IndexedDB connection
		if (this._message_db) {
			try {
				this._message_db.close();
			} catch (e) {
				/* ignore */
			}
			this._message_db = null;
		}
	},
	methods: {
		release_all_object_urls() {
			if (!this._object_urls) return;
			_.each(this._object_urls, url => {
				try {
					URL.revokeObjectURL(url);
				} catch (err) {
					// ignore malformed or already-revoked URLs
				}
			});
			this._object_urls = [];
		},
		set_message_object_url(message, blob) {
			if (!message || !blob) return null;
			if (message.url && typeof message.url === 'string' && message.url.indexOf('blob:') === 0) {
				try {
					URL.revokeObjectURL(message.url);
				} catch (err) {
					// ignore revoke failures
				}
			}
			var url = URL.createObjectURL(blob);
			message.url = url;
			this._object_urls.push(url);
			return url;
		},
		persist_file_blob(fileId, blob, fileMeta) {
			if (!this._message_db || !fileId || !blob) return Promise.resolve();
			return fileStore.saveFileBlob(this._message_db, fileId, blob, fileMeta).catch(err => {
				console.warn('save file blob failed', err);
			});
		},
		restore_file_urls_for_messages(messages) {
			if (!this._message_db || !messages || messages.length === 0) return Promise.resolve();
			var jobs = _.map(messages, message => {
				if (!message || !message.file) return Promise.resolve();
				var fileId = message.persisted_file_id || message.object_id;
				if (!fileId) return Promise.resolve();
				if (message.url && typeof message.url === 'string' && message.url.indexOf('blob:') === 0) {
					return Promise.resolve();
				}
				return fileStore.getFileBlob(this._message_db, fileId).then(blob => {
					if (!blob) return;
					this.set_message_object_url(message, blob);
				});
			});
			return Promise.all(jobs).catch(err => {
				console.warn('restore file URLs failed', err);
			});
		},
		to_storable_message_payload(message) {
			try {
				return JSON.parse(
					JSON.stringify(message, (key, value) => {
						if (key === 'date' || key === '_persisted_pk') return undefined;
						if (key === 'chunk') return undefined;
						if (key === 'url' && typeof value === 'string' && value.indexOf('blob:') === 0) {
							return undefined;
						}
						if (typeof Blob !== 'undefined' && value instanceof Blob) return undefined;
						if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return undefined;
						if (value && value._isAMomentObject) return value.valueOf();
						return value;
					})
				);
			} catch (err) {
				console.warn('serialize message failed', err);
				return null;
			}
		},
		normalize_message_from_store(record) {
			var payload = record.payload || {};
			var msg = {
				...payload,
				date: moment(record.createdAt),
				_persisted_pk: record.pk,
				// In-memory only: marks this message as loaded from history so
				// renderers (e.g. native-file-item voice autoplay) can skip
				// behaviors that should only run for freshly-arrived messages.
				history: true
			};
			// History older than 1 hour cannot still be loading, force clear stale state
			if (msg.loading && moment().diff(moment(record.createdAt), 'hours') >= 1) {
				msg.loading = false;
				msg.status = null;
			}
			return msg;
		},
		init_message_store() {
			if (!messageStore.supportsIndexedDb()) {
				console.log('indexedDB unavailable, skip local message persistence');
				return;
			}
			messageStore
				.openDb()
				.then(db => {
					this._message_db = db;

					if (db) {
						return this.load_messages_from_store();
					}
				})
				.catch(err => {
					console.warn('init indexedDB message store failed', err);
				});
		},
		load_messages_from_store() {
			if (!this._message_db || !this.group) {
				return Promise.resolve();
			}
			// request PAGE_SIZE+1 to detect if more history exists
			return messageStore
				.listByGroup(this._message_db, this.group, PAGE_SIZE + 1)
				.then(records => {
					this.hasMoreMessages = records.length > PAGE_SIZE;
					if (this.hasMoreMessages) {
						records = records.slice(-PAGE_SIZE);
					}
					this.release_all_object_urls();
					this.messages = _.map(records, rec => this.normalize_message_from_store(rec));
					return this.restore_file_urls_for_messages(this.messages);
				})
				.then(() => {
					this.$nextTick(() => {
						setTimeout(() => {
							this.scrollToBottomNow();
						}, 0);
					});
				})
				.catch(err => {
					console.warn('load messages from indexedDB failed', err);
				});
		},
		upsert_message_to_store(message) {
			if (!this._message_db || !this.group || !message) return Promise.resolve();
			var payload = this.to_storable_message_payload(message);
			if (!payload) return Promise.resolve();

			var nowTs = Date.now();
			var createdAt = message && message.date ? moment(message.date).valueOf() : nowTs;
			var record = {
				group: this.group,
				messageId: message.id || null,
				createdAt,
				updatedAt: nowTs,
				payload
			};

			if (message._persisted_pk) {
				record.pk = message._persisted_pk;
				return messageStore.putMessage(this._message_db, record).catch(err => {
					console.warn('put message by primary key failed', err);
				});
			}

			if (!message.id) {
				return messageStore.putMessage(this._message_db, record).catch(err => {
					console.warn('append message failed', err);
				});
			}

			return messageStore
				.getFirstByGroupMessageId(this._message_db, this.group, message.id)
				.then(found => {
					if (found) {
						record.pk = found.pk;
					}
					return messageStore.putMessage(this._message_db, record);
				})
				.then(saved => {
					if (saved && saved.pk) {
						message['_persisted_pk'] = saved.pk;
					}
				})
				.catch(err => {
					console.warn('upsert message by group/messageId failed', err);
				});
		},
		queue_upsert_message_to_store(message) {
			if (!message || !message.id) {
				return this.upsert_message_to_store(message);
			}
			if (!this._persist_message_debouncers[message.id]) {
				this._persist_message_debouncers[message.id] = _.debounce(() => {
					this.upsert_message_to_store(message);
				}, 300);
			}
			this._persist_message_debouncers[message.id]();
		}
	}
};
