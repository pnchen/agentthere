import _ from 'underscore';
_.templateSettings = {
	evaluate: /\{\[([\s\S]+?)\]\}/g,
	interpolate: /\{\{(.+?)\}\}/g
};

import toastr from 'js/lib/toastr/toastr.js';
import 'js/lib/toastr/toastr.css';

toastr.options.positionClass = 'toast-bottom-center';
toastr.options.timeOut = 3000;
toastr.options.showDuration = 150;
toastr.showError = function (err) {
	if (err.response) {
		console.log(err.response);
		if (_.isObject(err.response.data)) {
			return toastr.error(err.response.data.message);
		} else {
			return toastr.error(err.response.data);
		}
	}
	if (err.message) toastr.error(err.message.replace(/\n/g, '<br>').replace(/ /g, '&nbsp;'));
};

import * as bootstrap from 'bootstrap';
window.bootstrap = bootstrap;

import axios from 'axios';
import axios_progress_bar from 'axios-progress-bar';
// axios_progress_bar.loadProgressBar({ speed: 800 }, axios);

import qs from 'qs';

import moment from 'moment';
import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import vue_flatpickr from 'vue-flatpickr-component';

import 'webrtc-adapter';

import appModule from 'module/app.js';
import coms from 'js/coms';
import groupComs from 'module/group/coms/';
import homeComponent from 'module/home';
import groupComponent from 'module/group';

const app = createApp({ ...appModule });

app.component('flat-pickr', vue_flatpickr);
app.use(coms);
app.use(groupComs);

app.mixin({
	created() {
		this.moment = moment;
		this.toastr = toastr;
		this.qs = qs;
	}
});

var router = createRouter({
	history: createWebHashHistory(),
	routes: [
		{ path: '/:pathMatch(.*)*', redirect: '/home' },

		{ path: '/home/', component: homeComponent },
		{ path: '/room/:group', component: groupComponent },
		{ path: '/group/:group', component: groupComponent }
	],
	parseQuery(query) {
		return qs.parse(query);
	},
	stringifyQuery(query) {
		return qs.stringify(query);
	}
});

app.use(router);
app.mount('#app');
