var DB_NAME = 'rtc_local_chat';
var DB_VERSION = 3;
var STORE_MESSAGES = 'messages';
var STORE_FILES = 'files';
var textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function getRecordGroup(record) {
	if (!record) return null;
	return record.group || record.room || null;
}

function normalizeMessageRecord(record) {
	if (!record) return record;
	var group = getRecordGroup(record);
	if (group && !record.group) {
		record.group = group;
	}
	return record;
}

function ensureMessageStoreIndexes(store) {
	if (!store.indexNames.contains('byGroupCreatedAt')) {
		store.createIndex('byGroupCreatedAt', ['group', 'createdAt'], { unique: false });
	}
	if (!store.indexNames.contains('byGroupMessageId')) {
		store.createIndex('byGroupMessageId', ['group', 'messageId'], { unique: false });
	}
	if (!store.indexNames.contains('byCreatedAt')) {
		store.createIndex('byCreatedAt', 'createdAt', { unique: false });
	}
}

function migrateMessageRecords(store) {
	return new Promise((resolve, reject) => {
		var req = store.openCursor();
		req.onsuccess = () => {
			var cursor = req.result;
			if (!cursor) {
				resolve();
				return;
			}
			var record = cursor.value;
			var group = getRecordGroup(record);
			if (group && !record.group) {
				cursor.update({
					...record,
					group
				});
			}
			cursor.continue();
		};
		req.onerror = () => reject(req.error || new Error('migrate indexedDB messages failed'));
	});
}

function createGroupRange(group, upperTs) {
	if (typeof upperTs === 'number') {
		return IDBKeyRange.bound([group, 0], [group, upperTs], false, true);
	}
	return IDBKeyRange.bound([group, 0], [group, Number.MAX_SAFE_INTEGER]);
}

function supportsIndexedDb() {
	return typeof window !== 'undefined' && !!window.indexedDB;
}

function checkStorageQuota() {
	if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
		return Promise.resolve(null);
	}
	return navigator.storage.estimate().then(estimate => {
		return {
			usage: estimate.usage || 0,
			quota: estimate.quota || 0,
			usagePercent: estimate.quota ? Math.round((estimate.usage / estimate.quota) * 100) : 0
		};
	}).catch(() => null);
}

function requestToPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('indexedDB request failed'));
	});
}

function openDb() {
	if (!supportsIndexedDb()) {
		return Promise.resolve(null);
	}
	return new Promise((resolve, reject) => {
		var req = window.indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = event => {
			var db = event.target.result;
			var store;
			if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
				store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'pk', autoIncrement: true });
			} else {
				store = event.target.transaction.objectStore(STORE_MESSAGES);
			}
			ensureMessageStoreIndexes(store);
			migrateMessageRecords(store).catch(err => {
				console.warn(err);
			});
			if (!db.objectStoreNames.contains(STORE_FILES)) {
				var fileStore = db.createObjectStore(STORE_FILES, { keyPath: 'id' });
				fileStore.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error('open indexedDB failed'));
	});
}

function listAllUsedFileIds(db) {
	if (!db) return Promise.resolve([]);
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var ids = {};
			var req = store.openCursor();
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve(Object.keys(ids));
					return;
				}
				var payload = cursor.value && cursor.value.payload;
				if (payload) {
					var fileId = payload.persisted_file_id || payload.object_id;
					if (payload.file && fileId) {
						ids[fileId] = 1;
					}
				}
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('list used file ids failed'));
		});
	});
}

function withStore(db, mode, run) {
	return new Promise((resolve, reject) => {
		var tx = db.transaction(STORE_MESSAGES, mode);
		var store = tx.objectStore(STORE_MESSAGES);
		var result;
		try {
			result = run(store, tx);
		} catch (err) {
			reject(err);
			return;
		}
		tx.oncomplete = () => resolve(result);
		tx.onerror = () => reject(tx.error || new Error('indexedDB transaction failed'));
		tx.onabort = () => reject(tx.error || new Error('indexedDB transaction aborted'));
	});
}

function listByGroup(db, group, limit) {
	if (!db) return Promise.resolve([]);
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var records = [];
			var index = store.index('byGroupCreatedAt');
			var range = createGroupRange(group);
			var req = index.openCursor(range, 'prev');
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					records.reverse();
					resolve(records);
					return;
				}
				records.push(cursor.value);
				if (limit && records.length >= limit) {
					records.reverse();
					resolve(records);
					return;
				}
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('openCursor failed'));
		});
	});
}

function listByGroupDateRange(db, group, startTs, endTs) {
	if (!db) return Promise.resolve([]);
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var records = [];
			var index = store.index('byGroupCreatedAt');
			// [group, startTs] … [group, endTs]
			var range = IDBKeyRange.bound([group, startTs], [group, endTs]);
			var req = index.openCursor(range, 'next');
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve(records);
					return;
				}
				records.push(cursor.value);
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('openCursor by date range failed'));
		});
	});
}

function listMessageDaysByGroup(db, group) {
	if (!db) return Promise.resolve([]);
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var days = {};
			var index = store.index('byGroupCreatedAt');
			var range = createGroupRange(group);
			var req = index.openCursor(range, 'next');
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve(Object.keys(days).sort());
					return;
				}
				var ts = cursor.value && cursor.value.createdAt;
				if (typeof ts === 'number') {
					var d = new Date(ts);
					var key = d.getFullYear() + '-' +
						String(d.getMonth() + 1).padStart(2, '0') + '-' +
						String(d.getDate()).padStart(2, '0');
					days[key] = 1;
				}
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('list message days failed'));
		});
	});
}

function putMessage(db, record) {
	if (!db) return Promise.resolve(null);
	record = normalizeMessageRecord(record);
	return new Promise((resolve, reject) => {
		var tx = db.transaction(STORE_MESSAGES, 'readwrite');
		var store = tx.objectStore(STORE_MESSAGES);
		var req = store.put(record);
		var pk = null;
		req.onsuccess = () => {
			pk = req.result;
		};
		tx.oncomplete = () => resolve({ pk });
		tx.onerror = () => reject(tx.error || new Error('indexedDB transaction failed'));
		tx.onabort = () => reject(tx.error || new Error('indexedDB transaction aborted'));
	});
}

function estimateRecordBytes(record) {
	var payloadSize = 0;
	try {
		var payloadStr = JSON.stringify(record && record.payload ? record.payload : {});
		payloadSize = textEncoder ? textEncoder.encode(payloadStr).length : payloadStr.length * 2;
	} catch (err) {
		payloadSize = 0;
	}
	// Rough metadata overhead to make the estimate closer to actual storage footprint.
	return payloadSize + 128;
}

function getFirstByGroupMessageId(db, group, messageId) {
	if (!db || !messageId) return Promise.resolve(null);
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var index = store.index('byGroupMessageId');
			var req = index.openCursor(IDBKeyRange.only([group, messageId]));
			req.onsuccess = () => {
				var cursor = req.result;
				resolve(cursor ? cursor.value : null);
			};
			req.onerror = () => reject(req.error || new Error('lookup by group+messageId failed'));
		});
	});
}

function clearGroup(db, group) {
	if (!db) return Promise.resolve(0);
	return withStore(db, 'readwrite', store => {
		return new Promise((resolve, reject) => {
			var count = 0;
			var index = store.index('byGroupCreatedAt');
			var range = createGroupRange(group);
			var req = index.openCursor(range);
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve(count);
					return;
				}
				store.delete(cursor.primaryKey);
				count += 1;
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('clear group failed'));
		});
	});
}

function estimateClearGroup(db, group) {
	if (!db) return Promise.resolve({ count: 0, bytes: 0 });
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var count = 0;
			var bytes = 0;
			var index = store.index('byGroupCreatedAt');
			var range = createGroupRange(group);
			var req = index.openCursor(range);
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve({ count, bytes });
					return;
				}
				count += 1;
				bytes += estimateRecordBytes(cursor.value);
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('estimate clear group failed'));
		});
	});
}

function clearOlderThan(db, beforeTs, group) {
	if (!db) return Promise.resolve(0);
	return withStore(db, 'readwrite', store => {
		return new Promise((resolve, reject) => {
			var count = 0;
			var req;
			if (group) {
				var groupRange = createGroupRange(group, beforeTs);
				req = store.index('byGroupCreatedAt').openCursor(groupRange);
			} else {
				req = store.index('byCreatedAt').openCursor(IDBKeyRange.upperBound(beforeTs, true));
			}
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve(count);
					return;
				}
				store.delete(cursor.primaryKey);
				count += 1;
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('clear older messages failed'));
		});
	});
}

function estimateClearOlderThan(db, beforeTs, group) {
	if (!db) return Promise.resolve({ count: 0, bytes: 0 });
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var count = 0;
			var bytes = 0;
			var req;
			if (group) {
				var groupRange = createGroupRange(group, beforeTs);
				req = store.index('byGroupCreatedAt').openCursor(groupRange);
			} else {
				req = store.index('byCreatedAt').openCursor(IDBKeyRange.upperBound(beforeTs, true));
			}
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve({ count, bytes });
					return;
				}
				count += 1;
				bytes += estimateRecordBytes(cursor.value);
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('estimate clear older failed'));
		});
	});
}

function listGroups(db) {
	if (!db) return Promise.resolve([]);
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var groups = {};
			var req = store.openCursor();
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve(Object.keys(groups));
					return;
				}
				var group = getRecordGroup(cursor.value);
				if (group) groups[group] = 1;
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('list groups failed'));
		});
	});
}

function keepRecentByGroup(db, limit) {
	if (!db) return Promise.resolve(0);
	if (!limit || limit < 1) return Promise.resolve(0);
	return listGroups(db).then(groups => {
		var totalDeleted = 0;
		var chain = Promise.resolve();
		groups.forEach(group => {
			chain = chain.then(() => {
				return withStore(db, 'readwrite', store => {
					return new Promise((resolve, reject) => {
						var index = store.index('byGroupCreatedAt');
						var range = createGroupRange(group);
						var req = index.openCursor(range, 'prev');
						var seen = 0;
						var deleted = 0;
						req.onsuccess = () => {
							var cursor = req.result;
							if (!cursor) {
								totalDeleted += deleted;
								resolve();
								return;
							}
							seen += 1;
							if (seen > limit) {
								store.delete(cursor.primaryKey);
								deleted += 1;
							}
							cursor.continue();
						};
						req.onerror = () => reject(req.error || new Error('keep recent by group failed'));
					});
				});
			});
		});
		return chain.then(() => totalDeleted);
	});
}

function estimateKeepRecentByGroup(db, limit) {
	if (!db || !limit || limit < 1) return Promise.resolve({ count: 0, bytes: 0 });
	return listGroups(db).then(groups => {
		var summary = { count: 0, bytes: 0 };
		var chain = Promise.resolve();
		groups.forEach(group => {
			chain = chain.then(() => {
				return withStore(db, 'readonly', store => {
					return new Promise((resolve, reject) => {
						var index = store.index('byGroupCreatedAt');
						var range = createGroupRange(group);
						var req = index.openCursor(range, 'prev');
						var seen = 0;
						req.onsuccess = () => {
							var cursor = req.result;
							if (!cursor) {
								resolve();
								return;
							}
							seen += 1;
							if (seen > limit) {
								summary.count += 1;
								summary.bytes += estimateRecordBytes(cursor.value);
							}
							cursor.continue();
						};
						req.onerror = () => reject(req.error || new Error('estimate keep recent by group failed'));
					});
				});
			});
		});
		return chain.then(() => summary);
	});
}

function deleteByPrimaryKeys(db, keys) {
	if (!db || !keys || keys.length === 0) return Promise.resolve(0);
	return withStore(db, 'readwrite', store => {
		keys.forEach(pk => store.delete(pk));
		return keys.length;
	});
}

function estimateCountByGroup(db, group) {
	if (!db) return Promise.resolve(0);
	return withStore(db, 'readonly', store => {
		var range = createGroupRange(group);
		var req = store.index('byGroupCreatedAt').count(range);
		return requestToPromise(req);
	});
}

function estimateMessagesStorage(db) {
	if (!db) return Promise.resolve({ count: 0, bytes: 0 });
	return withStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var count = 0;
			var bytes = 0;
			var req = store.openCursor();
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve({ count, bytes });
					return;
				}
				count += 1;
				bytes += estimateRecordBytes(cursor.value);
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('estimate messages storage failed'));
		});
	});
}

export default {
	supportsIndexedDb,
	checkStorageQuota,
	openDb,
	listByGroup,
	listByGroupDateRange,
	listMessageDaysByGroup,
	putMessage,
	estimateRecordBytes,
	getFirstByGroupMessageId,
	clearGroup,
	estimateClearGroup,
	clearOlderThan,
	estimateClearOlderThan,
	listGroups,
	keepRecentByGroup,
	estimateKeepRecentByGroup,
	deleteByPrimaryKeys,
	estimateCountByGroup,
	estimateMessagesStorage,
	listAllUsedFileIds
};
