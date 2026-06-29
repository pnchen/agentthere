/*
 * Toastr
 * Copyright 2012-2014 John Papa and Hans Fjällemark.
 * All Rights Reserved.
 * Use, reproduction, distribution, and modification of this code is subject to the terms and
 * conditions of the MIT license, available at http://www.opensource.org/licenses/mit-license.php
 *
 * Author: John Papa and Hans Fjällemark
 * ARIA Support: Greta Krafsig
 * Project: https://github.com/CodeSeven/toastr
 *
 * Rewritten without jQuery dependency (vanilla DOM + CSS transitions).
 */

// ---------- helpers ----------

function extend(target) {
	for (var i = 1; i < arguments.length; i++) {
		var src = arguments[i];
		if (src) {
			for (var key in src) {
				if (Object.prototype.hasOwnProperty.call(src, key)) {
					target[key] = src[key];
				}
			}
		}
	}
	return target;
}

function parseHtml(html) {
	var tmp = document.createElement('div');
	tmp.innerHTML = html;
	return tmp.firstChild;
}

function hasFocus(el) {
	return el ? !!el.querySelector(':focus') : false;
}

// CSS transition-based show (fadeIn / slideDown / show)
function animateShow(el, method, duration, onDone) {
	el.style.transition = '';
	el.style.opacity = '0';
	el.style.display = 'block';
	// force reflow
	el.offsetHeight; // eslint-disable-line no-unused-expressions
	el.style.transition = 'opacity ' + duration + 'ms ease';
	el.style.opacity = '1';
	var done = false;
	function finish() {
		if (done) return;
		done = true;
		el.style.transition = '';
		if (onDone) onDone();
	}
	el.addEventListener('transitionend', finish, { once: true });
	// fallback in case transitionend doesn't fire
	setTimeout(finish, duration + 50);
}

// CSS transition-based hide (fadeOut / slideUp / hide)
function animateHide(el, duration, onDone) {
	el.style.transition = 'opacity ' + duration + 'ms ease';
	el.style.opacity = '0';
	var done = false;
	function finish() {
		if (done) return;
		done = true;
		el.style.transition = '';
		el.style.display = 'none';
		if (onDone) onDone();
	}
	el.addEventListener('transitionend', finish, { once: true });
	setTimeout(finish, duration + 50);
}

// ---------- module ----------

var container;
var listener;
var toastId = 0;
var toastType = {
	error: 'error',
	info: 'info',
	success: 'success',
	warning: 'warning'
};

var toastr = {
	clear: clear,
	remove: remove,
	error: error,
	getContainer: getContainer,
	info: info,
	options: {},
	subscribe: subscribe,
	success: success,
	version: '2.0.3',
	warning: warning
};

export default toastr;

//#region Accessible Methods

function error(message, title, optionsOverride) {
	return notify({
		type: toastType.error,
		iconClass: getOptions().iconClasses.error,
		message: message,
		optionsOverride: optionsOverride,
		title: title
	});
}

function getContainer(options, create) {
	if (!options) {
		options = getOptions();
	}
	container = document.getElementById(options.containerId);
	if (container) {
		return container;
	}
	if (create) {
		container = createContainer(options);
	}
	return container;
}

function info(message, title, optionsOverride) {
	return notify({
		type: toastType.info,
		iconClass: getOptions().iconClasses.info,
		message: message,
		optionsOverride: optionsOverride,
		title: title
	});
}

function subscribe(callback) {
	listener = callback;
}

function success(message, title, optionsOverride) {
	return notify({
		type: toastType.success,
		iconClass: getOptions().iconClasses.success,
		message: message,
		optionsOverride: optionsOverride,
		title: title
	});
}

function warning(message, title, optionsOverride) {
	return notify({
		type: toastType.warning,
		iconClass: getOptions().iconClasses.warning,
		message: message,
		optionsOverride: optionsOverride,
		title: title
	});
}

function clear(toastElement) {
	var options = getOptions();
	if (!container) {
		getContainer(options);
	}
	if (!clearToast(toastElement, options)) {
		clearContainer(options);
	}
}

function remove(toastElement) {
	var options = getOptions();
	if (!container) {
		getContainer(options);
	}
	if (toastElement && !hasFocus(toastElement)) {
		removeToast(toastElement);
		return;
	}
	if (container && container.children.length) {
		container.parentNode && container.parentNode.removeChild(container);
	}
}
//#endregion

//#region Internal Methods

function clearContainer(options) {
	var children = Array.prototype.slice.call(container.children);
	for (var i = children.length - 1; i >= 0; i--) {
		clearToast(children[i], options);
	}
}

function clearToast(toastElement, options) {
	if (toastElement && !hasFocus(toastElement)) {
		animateHide(toastElement, options.hideDuration, function () {
			removeToast(toastElement);
		});
		return true;
	}
	return false;
}

function createContainer(options) {
	container = document.createElement('div');
	container.setAttribute('id', options.containerId);
	container.className = options.positionClass;
	container.setAttribute('aria-live', 'polite');
	container.setAttribute('role', 'alert');

	var target = document.querySelector(options.target) || document.body;
	target.appendChild(container);
	return container;
}

function getDefaults() {
	return {
		tapToDismiss: true,
		toastClass: 'toast',
		containerId: 'toast-container',
		debug: false,

		showMethod: 'fadeIn',
		showDuration: 300,
		showEasing: 'swing',
		onShown: undefined,
		hideMethod: 'fadeOut',
		hideDuration: 1000,
		hideEasing: 'swing',
		onHidden: undefined,

		extendedTimeOut: 1000,
		iconClasses: {
			error: 'toast-error',
			info: 'toast-info',
			success: 'toast-success',
			warning: 'toast-warning'
		},
		iconClass: 'toast-info',
		positionClass: 'toast-top-right',
		timeOut: 5000, // Set timeOut and extendedTimeout to 0 to make it sticky
		titleClass: 'toast-title',
		messageClass: 'toast-message',
		target: 'body',
		closeHtml: '<button>&times;</button>',
		newestOnTop: true
	};
}

function publish(args) {
	if (!listener) {
		return;
	}
	listener(args);
}

function notify(map) {
	var options = getOptions(),
		iconClass = map.iconClass || options.iconClass;

	if (typeof map.optionsOverride !== 'undefined') {
		options = extend({}, options, map.optionsOverride);
		iconClass = map.optionsOverride.iconClass || iconClass;
	}

	toastId++;

	container = getContainer(options, true);

	var intervalId = null,
		toastElement = document.createElement('div'),
		titleElement = document.createElement('div'),
		messageElement = document.createElement('div'),
		closeElement = parseHtml(options.closeHtml),
		response = {
			toastId: toastId,
			state: 'visible',
			startTime: new Date(),
			options: options,
			map: map
		};

	if (map.iconClass) {
		toastElement.className = options.toastClass + ' ' + iconClass;
	}

	if (map.title) {
		titleElement.innerHTML = map.title;
		titleElement.className = options.titleClass;
		toastElement.appendChild(titleElement);
	}

	if (map.message) {
		messageElement.innerHTML = map.message;
		messageElement.className = options.messageClass;
		toastElement.appendChild(messageElement);
	}

	if (options.closeButton && closeElement) {
		closeElement.classList.add('toast-close-button');
		closeElement.setAttribute('role', 'button');
		toastElement.insertBefore(closeElement, toastElement.firstChild);
	}

	toastElement.style.display = 'none';
	if (options.newestOnTop) {
		container.insertBefore(toastElement, container.firstChild);
	} else {
		container.appendChild(toastElement);
	}

	animateShow(toastElement, options.showMethod, options.showDuration, options.onShown);

	if (options.timeOut > 0) {
		intervalId = setTimeout(hideToast, options.timeOut);
	}

	toastElement.addEventListener('mouseenter', stickAround);
	toastElement.addEventListener('mouseleave', delayedHideToast);

	if (!options.onclick && options.tapToDismiss) {
		toastElement.addEventListener('click', hideToast);
	}

	if (options.closeButton && closeElement) {
		closeElement.addEventListener('click', function (event) {
			event.stopPropagation();
			hideToast(true);
		});
	}

	if (options.onclick) {
		toastElement.addEventListener('click', function () {
			options.onclick();
			hideToast();
		});
	}

	publish(response);

	if (options.debug && console) {
		console.log(response);
	}

	return toastElement;

	function hideToast(override) {
		if (hasFocus(toastElement) && !override) {
			return;
		}
		animateHide(toastElement, options.hideDuration, function () {
			removeToast(toastElement);
			if (options.onHidden && response.state !== 'hidden') {
				options.onHidden();
			}
			response.state = 'hidden';
			response.endTime = new Date();
			publish(response);
		});
	}

	function delayedHideToast() {
		if (options.timeOut > 0 || options.extendedTimeOut > 0) {
			intervalId = setTimeout(hideToast, options.extendedTimeOut);
		}
	}

	function stickAround() {
		clearTimeout(intervalId);
		toastElement.style.transition = '';
		toastElement.style.opacity = '1';
	}
}

function getOptions() {
	return extend({}, getDefaults(), toastr.options);
}

function removeToast(toastElement) {
	if (!container) {
		container = getContainer();
	}
	if (toastElement.offsetParent !== null) {
		// still visible, skip
		return;
	}
	if (toastElement.parentNode) {
		toastElement.parentNode.removeChild(toastElement);
	}
	toastElement = null;
	if (container && container.children.length === 0) {
		container.parentNode && container.parentNode.removeChild(container);
		container = null;
	}
}
//#endregion
