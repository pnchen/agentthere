import actionMenu from './action-menu';
import rtcPeer from './rtc-peer';
import inputMedia from './input-media';
import inputWebcam from './input-webcam';
import rtcGroupSignaling from './rtc-group-signaling';
import videoStreamPreview from './video-stream-preview';

var coms = { actionMenu, rtcPeer, inputMedia, inputWebcam, rtcGroupSignaling, videoStreamPreview };
export default {
	install(Vue) {
		Object.keys(coms).forEach(k => Vue.component(k, coms[k]));
	}
};
