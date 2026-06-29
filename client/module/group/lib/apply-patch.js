/**
 * Generic JSON patch applier used by the peer-side message store to
 * absorb agent streaming updates from the AgentThere channel.
 *
 * The protocol is documented in src/channel/agentthere/PROTOCOL.md §3.2.13. A
 * single message broadcast can carry one or more ops:
 *
 *   { id, _patch: [{ op, path, value? | chunk? }, ...] }
 *
 * Supported ops:
 *   - set         replace the value at path
 *   - merge       Object.assign on the existing object (or create new)
 *   - push        append value to the array at path (creates [] if needed)
 *   - append_text concat chunk onto the string at path (creates "" if needed)
 *   - remove      delete object key or splice array element at path (no-op if missing)
 *
 * Path syntax (very small subset):
 *   reasoning
 *   segments
 *   segments[2].text
 *   segments[sid=s1].text
 *   segments[sid=s2].events
 *
 * Numeric brackets index into arrays; key=value brackets find the first
 * array entry whose property matches. This is enough to update segments
 * and event lists without server-allocated indexes.
 */

function parse_path(pathStr) {
	if (!pathStr) return [];
	// Split on dots first, then expand bracket selectors. Each token is
	// either a plain key, [n] index, or [k=v] key-selector.
	var raw = String(pathStr).split('.');
	var out = [];
	for (var i = 0; i < raw.length; i++) {
		var token = raw[i];
		// Pull leading identifier.
		var m = token.match(/^([a-zA-Z_][\w-]*)/);
		if (m) {
			out.push({ kind: 'key', key: m[1] });
			token = token.slice(m[1].length);
		}
		// Then any number of [...] selectors.
		while (token.length > 0) {
			var br = token.match(/^\[([^\]]+)\]/);
			if (!br) break;
			var inner = br[1];
			if (/^\d+$/.test(inner)) {
				out.push({ kind: 'index', index: parseInt(inner, 10) });
			} else {
				var eq = inner.indexOf('=');
				if (eq < 0) break;
				out.push({
					kind: 'select',
					selKey: inner.slice(0, eq).trim(),
					selVal: inner.slice(eq + 1).trim()
				});
			}
			token = token.slice(br[0].length);
		}
	}
	return out;
}

function resolve_index(parent, seg) {
	if (seg.kind === 'index') return seg.index;
	if (seg.kind === 'select') {
		if (!Array.isArray(parent)) return -1;
		for (var i = 0; i < parent.length; i++) {
			if (parent[i] && String(parent[i][seg.selKey]) === seg.selVal) {
				return i;
			}
		}
		return -1;
	}
	return -1;
}

/**
 * Walk segs[0..-2], returning [parent, lastSeg]. Auto-creates missing
 * containers conservatively so push/append_text can land on a fresh path.
 */
function resolve_parent(target, segs) {
	if (segs.length === 0) return null;
	var node = target;
	for (var i = 0; i < segs.length - 1; i++) {
		var seg = segs[i];
		if (seg.kind === 'key') {
			if (node[seg.key] === undefined || node[seg.key] === null) {
				// Look ahead: if next seg is index/select, this should be an array.
				var nx = segs[i + 1];
				node[seg.key] = nx && (nx.kind === 'index' || nx.kind === 'select') ? [] : {};
			}
			node = node[seg.key];
		} else {
			var idx = resolve_index(node, seg);
			if (idx < 0 || !node[idx]) return null;
			node = node[idx];
		}
	}
	return node;
}

function apply_one(target, op) {
	var segs = parse_path(op.path);
	if (segs.length === 0) return;
	var parent = resolve_parent(target, segs);
	if (!parent) return;
	var last = segs[segs.length - 1];
	var key;
	if (last.kind === 'key') {
		key = last.key;
	} else {
		var idx = resolve_index(parent, last);
		if (idx < 0) return;
		key = idx;
	}
	switch (op.op) {
		case 'set':
			parent[key] = op.value;
			return;
		case 'merge':
			if (parent[key] && typeof parent[key] === 'object' && !Array.isArray(parent[key])) {
				Object.assign(parent[key], op.value || {});
			} else {
				parent[key] = { ...(op.value || {}) };
			}
			return;
		case 'push':
			if (!Array.isArray(parent[key])) parent[key] = [];
			parent[key].push(op.value);
			return;
		case 'remove':
			if (last.kind === 'key') {
				delete parent[key];
			} else {
				parent.splice(key, 1);
			}
			return;
		case 'append_text':
			parent[key] = (parent[key] == null ? '' : String(parent[key])) + (op.chunk == null ? '' : String(op.chunk));
			return;
		default:
			return;
	}
}

export default function apply_patch(target, ops) {
	if (!target || !Array.isArray(ops)) return;
	for (var i = 0; i < ops.length; i++) {
		try {
			apply_one(target, ops[i]);
		} catch (err) {
			console.warn('apply_patch op failed', ops[i], err);
		}
	}
}
