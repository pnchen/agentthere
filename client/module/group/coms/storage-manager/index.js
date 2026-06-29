import _ from 'underscore';
import moment from 'moment';
import toastr from 'js/lib/toastr/toastr.js';
import messageStore from '../../lib/message-store';
import fileStore from '../../lib/file-store';

import modal from 'js/mixins/modal.js';

export default {
	template: require('./index.html?raw'),
	mixins: [modal],
	props: {
		group: { type: String, required: true }
	},
	data() {
		return {
			db: null,
			busy: false,
			olderDays: 7,
			keepCount: 200,
			stat: {
				roomCount: 0,
				messageStat: { count: 0, bytes: 0 },
				fileStat: { count: 0, bytes: 0 },
				orphanStat: { count: 0, bytes: 0 },
				totalBytes: 0,
				storageQuota: null
			}
		};
	},
	methods: {
		formatBytes(bytes) {
			var size = Number(bytes || 0);
			if (size < 1024) return `${size} B`;
			if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
			if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
			return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
		},
		loadStats() {
			if (!this.db) return;
			return Promise.all([
				messageStore.estimateMessagesStorage(this.db),
				fileStore.estimateFileStorage(this.db),
				messageStore.estimateCountByGroup(this.db, this.group)
			])
				.then(([messageStat, fileStat, roomCount]) => {
					return messageStore.listAllUsedFileIds(this.db).then(usedIds => {
						return fileStore.estimateOrphanFileStorage(this.db, usedIds || []).then(orphanStat => {
							this.stat.roomCount = roomCount || 0;
							this.stat.messageStat = messageStat || { count: 0, bytes: 0 };
							this.stat.fileStat = fileStat || { count: 0, bytes: 0 };
							this.stat.orphanStat = orphanStat || { count: 0, bytes: 0 };
							this.stat.totalBytes = (this.stat.messageStat.bytes || 0) + (this.stat.fileStat.bytes || 0);
						});
					});
				})
				.then(() => {
					return messageStore.checkStorageQuota().then(quota => {
						this.stat.storageQuota = quota;
					});
				})
				.catch(err => {
					console.warn('storage-manager: load stats failed', err);
					toastr.error('Failed to load storage stats');
				});
		},
		doCleanup(action) {
			this.result = null;
			var doIt = null;
			var label = '';

			switch (action) {
				case 'orphan':
					if (!this.stat.orphanStat.count) return;
					if (!window.confirm(`Delete ${this.stat.orphanStat.count} orphan file(s)?`)) return;
					label = 'Cleaned up orphan files';
					doIt = () => {
						return messageStore.listAllUsedFileIds(this.db).then(usedIds => fileStore.cleanupOrphanFiles(this.db, usedIds || []));
					};
					break;
				case 'clearGroup':
					if (!window.confirm(`Clear ALL messages in "${this.group}"?`)) return;
					label = `Cleared ${this.group}`;
					doIt = () => {
						return messageStore.estimateClearGroup(this.db, this.group).then(estimate => {
							if (!estimate || !estimate.count) return 0;
							return messageStore.clearGroup(this.db, this.group);
						});
					};
					break;
				case 'olderThan':
					if (!this.olderDays || this.olderDays < 1) return;
					var days = this.olderDays;
					if (!window.confirm(`Delete messages in "${this.group}" older than ${days} day(s)?`)) return;
					label = `Cleared messages older than ${days} days in ${this.group}`;
					doIt = () => {
						var beforeTs = moment().subtract(days, 'days').valueOf();
						return messageStore.estimateClearOlderThan(this.db, beforeTs, this.group).then(estimate => {
							if (!estimate || !estimate.count) return 0;
							return messageStore.clearOlderThan(this.db, beforeTs, this.group);
						});
					};
					break;
				case 'keepRecent':
					if (!this.keepCount || this.keepCount < 1) return;
					var limit = this.keepCount;
					if (!window.confirm(`Keep only the most recent ${limit} messages in "${this.group}"?`)) return;
					label = `Kept recent ${limit} messages in ${this.group}`;
					doIt = () => {
						return messageStore.listByGroup(this.db, this.group).then(records => {
							if (!records || records.length <= limit) return 0;
							var toDelete = records.slice(limit);
							var pks = _.map(toDelete, r => r.pk).filter(Boolean);
							return messageStore.deleteByPrimaryKeys(this.db, pks);
						});
					};
					break;
				default:
					return;
			}

			this.busy = true;
			Promise.resolve()
				.then(() => doIt())
				.then(count => {
					toastr.success(`${label}: ${count || 0} deleted`);
					// 通知父组件刷新消息列表
					if (action !== 'orphan') {
						this.$emit('cleaned', { action: 'messages_cleaned' });
					}
					return this.loadStats();
				})
				.catch(err => {
					console.warn('storage-manager: cleanup failed', err);
					toastr.error('Cleanup failed');
				})
				.then(() => {
					this.busy = false;
				});
		}
	},
	mounted() {
		if (messageStore.supportsIndexedDb()) {
			messageStore
				.openDb()
				.then(db => {
					this.db = db;
					return this.loadStats();
				})
				.catch(err => {
					console.warn('storage-manager: openDb failed', err);
					toastr.error('Failed to open local database. Storage may be unavailable.');
				});
		}
	},
	beforeUnmount() {
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
