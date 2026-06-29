import userTitle from './user-title';
var coms = { userTitle };
export default {
	install(Vue) {
		Object.keys(coms).forEach(k => {
			Vue.component(k, coms[k]);
		});
	}
};
