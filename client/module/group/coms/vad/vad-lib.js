import _ from 'underscore';
import { MicVAD } from '@ricky0123/vad-web';

var VAD_RESOLVED_BASE = new URL('./vad/', location.href).href;
var DEFAULT_OPEN_DELAY_MS = 500;

function stop_stream(stream) {
	if (!stream) return;
	stream.getTracks().forEach(track => {
		try {
			track.stop();
		} catch (err) {
			// ignore stop failures for already-ended cloned tracks
		}
	});
}

function clone_stream_by_kind(stream, kind) {
	return new MediaStream(
		stream
			.getTracks()
			.filter(track => track.kind === kind)
			.map(track => track.clone())
	);
}

function reference_stream_by_kind(stream, kind) {
	return new MediaStream(stream.getTracks().filter(track => track.kind === kind));
}

export default async function create_vad_stream(stream, options) {
	if (!stream) return null;

	var audioTracks = stream.getAudioTracks();
	var outputStream = new MediaStream();
	var gateInputStream = null;
	var vadInputStream = null;
	var sourceNode = null;
	var delayNode = null;
	var gainNode = null;
	var destinationNode = null;
	var destroyed = false;
	var audioContext = null;
	var settings = options || {};
	var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
	var emitStatus = typeof settings.onStatus === 'function' ? settings.onStatus : null;
	var openDelayMs = _.isNumber(settings.openDelayMs) ? settings.openDelayMs : DEFAULT_OPEN_DELAY_MS;
	var status = {
		phase: 'init',
		gateOpen: false,
		speechProb: null,
		error: null
	};
	var lastFrameStatusAt = 0;

	function notify_status(patch, force) {
		if (!emitStatus) return;
		var next = { ...status, ...(patch || {}) };
		if (!force && _.isEqual(next, status)) return;
		status = next;
		emitStatus({ ...status });
	}

	stream.getVideoTracks().forEach(track => {
		outputStream.addTrack(track.clone());
	});

	if (!audioTracks.length) {
		notify_status({ phase: 'no-audio', gateOpen: false }, true);
		return {
			stream: outputStream,
			start() {},
			pause() {},
			destroy() {
				stop_stream(outputStream);
			}
		};
	}

	if (!AudioContextCtor) {
		throw new Error('AudioContext unavailable');
	}

	// Do not clone the audio input here.
	// The source component toggles the original track.enabled between
	// listening/active; cloned tracks would keep the disabled snapshot and VAD
	// would see permanent silence.
	gateInputStream = reference_stream_by_kind(stream, 'audio');
	vadInputStream = reference_stream_by_kind(stream, 'audio');
	audioContext = new AudioContextCtor();

	if (audioContext.state === 'suspended') {
		try {
			await audioContext.resume();
		} catch (err) {
			console.warn('resume vad audio context failed', err);
		}
	}

	sourceNode = audioContext.createMediaStreamSource(gateInputStream);
	delayNode = audioContext.createDelay(1.0);
	gainNode = audioContext.createGain();
	destinationNode = audioContext.createMediaStreamDestination();
	delayNode.delayTime.value = Math.max(0, Math.min(1, openDelayMs / 1000));
	gainNode.gain.value = 0;
	sourceNode.connect(delayNode);
	delayNode.connect(gainNode);
	gainNode.connect(destinationNode);
	destinationNode.stream.getAudioTracks().forEach(track => {
		outputStream.addTrack(track);
	});

	function set_gate(open) {
		if (destroyed || !audioContext || !gainNode) return;
		var now = audioContext.currentTime;
		gainNode.gain.cancelScheduledValues(now);
		gainNode.gain.setTargetAtTime(open ? 1 : 0, now, 0.015);
		notify_status({ gateOpen: open, phase: open ? 'speech' : 'listening', error: null }, true);
	}

	var vad = await MicVAD.new({
		getStream: async () => vadInputStream,
		pauseStream: async () => {},
		resumeStream: async () => vadInputStream,
		baseAssetPath: VAD_RESOLVED_BASE,
		onnxWASMBasePath: VAD_RESOLVED_BASE,
		onFrameProcessed: probabilities => {
			var now = Date.now();
			if (now - lastFrameStatusAt < 120) return;
			lastFrameStatusAt = now;
			notify_status({ speechProb: probabilities && _.isNumber(probabilities.isSpeech) ? probabilities.isSpeech : null });
		},
		onSpeechStart: () => {
			notify_status({ phase: 'detecting', error: null }, true);
		},
		onSpeechRealStart: () => {
			set_gate(true);
		},
		onVADMisfire: () => {
			set_gate(false);
			// Reset GRU hidden state to avoid state accumulation affecting subsequent VAD
			if (vad && vad.frameProcessor) vad.frameProcessor.reset();
		},
		onSpeechEnd: () => {
			set_gate(false);
			// Reset GRU hidden state to avoid "silence bias" making the next phrase hard to activate
			if (vad && vad.frameProcessor) vad.frameProcessor.reset();
		},
		startOnLoad: false,
		model: 'v5',
		processorType: 'auto',
		...settings.vadOptions
	});
	notify_status({ phase: 'ready', gateOpen: false, error: null }, true);

	return {
		stream: outputStream,
		vad,
		start() {
			if (destroyed) return;
			if (audioContext && audioContext.state === 'suspended') {
				audioContext.resume().catch(err => {
					console.warn('resume vad audio context failed', err);
				});
			}
			notify_status({ phase: 'listening', gateOpen: false, error: null }, true);
			vad.start();
		},
		pause() {
			if (destroyed) return;
			set_gate(false);
			notify_status({ phase: 'paused', gateOpen: false }, true);
			vad.pause();
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			set_gate(false);
			notify_status({ phase: 'off', gateOpen: false }, true);
			try {
				vad.pause();
			} catch (err) {
				// ignore teardown race
			}
			if (sourceNode) sourceNode.disconnect();
			if (delayNode) delayNode.disconnect();
			if (gainNode) gainNode.disconnect();
			if (destinationNode) destinationNode.disconnect();
			if (audioContext) {
				audioContext.close().catch(err => {
					console.warn('close vad audio context failed', err);
				});
			}
			stop_stream(outputStream);
		}
	};
}
