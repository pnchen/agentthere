var STORE_FILES = 'files';

function withFileStore(db, mode, run) {
	return new Promise((resolve, reject) => {
		var tx = db.transaction(STORE_FILES, mode);
		var store = tx.objectStore(STORE_FILES);
		var result;
		try {
			result = run(store, tx);
		} catch (err) {
			reject(err);
			return;
		}
		tx.oncomplete = () => resolve(result);
		tx.onerror = () => reject(tx.error || new Error('file store transaction failed'));
		tx.onabort = () => reject(tx.error || new Error('file store transaction aborted'));
	});
}

function saveFileBlob(db, id, blob, meta) {
	if (!db || !id || !blob) return Promise.resolve(null);
	var now = Date.now();
	var record = {
		id,
		blob,
		size: blob.size || 0,
		type: blob.type || (meta && meta.type) || '',
		name: meta && meta.name,
		createdAt: (meta && meta.createdAt) || now,
		updatedAt: now
	};
	return withFileStore(db, 'readwrite', store => {
		store.put(record);
		return id;
	});
}

function getFileBlob(db, id) {
	if (!db || !id) return Promise.resolve(null);
	return withFileStore(db, 'readonly', store => {
		return new Promise((resolve, reject) => {
			var req = store.get(id);
			req.onsuccess = () => {
				var result = req.result;
				resolve(result && result.blob ? result.blob : null);
			};
			req.onerror = () => reject(req.error || new Error('get file blob failed'));
		});
	});
}

function cleanupOrphanFiles(db, usedFileIds) {
	if (!db) return Promise.resolve(0);
	var used = {};
	(usedFileIds || []).forEach(id => {
		if (id) used[id] = 1;
	});
	return withFileStore(db, 'readwrite', store => {
		return new Promise((resolve, reject) => {
			var deleted = 0;
			var req = store.openCursor();
			req.onsuccess = () => {
				var cursor = req.result;
				if (!cursor) {
					resolve(deleted);
					return;
				}
				if (!used[cursor.key]) {
					store.delete(cursor.key);
					deleted += 1;
				}
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('cleanup orphan files failed'));
		});
	});
}

function estimateFileStorage(db) {
	if (!db) return Promise.resolve({ count: 0, bytes: 0 });
	return withFileStore(db, 'readonly', store => {
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
				bytes += cursor.value && cursor.value.size ? cursor.value.size : 0;
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('estimate file storage failed'));
		});
	});
}

function estimateOrphanFileStorage(db, usedFileIds) {
	if (!db) return Promise.resolve({ count: 0, bytes: 0 });
	var used = {};
	(usedFileIds || []).forEach(id => {
		if (id) used[id] = 1;
	});
	return withFileStore(db, 'readonly', store => {
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
				if (!used[cursor.key]) {
					count += 1;
					bytes += cursor.value && cursor.value.size ? cursor.value.size : 0;
				}
				cursor.continue();
			};
			req.onerror = () => reject(req.error || new Error('estimate orphan file storage failed'));
		});
	});
}

export default {
	saveFileBlob,
	getFileBlob,
	cleanupOrphanFiles,
	estimateFileStorage,
	estimateOrphanFileStorage
};
