export default function (message) {
	return Promise.resolve()
		.then(() => {
			return window.confirm(message);
		})
		.then(result => {
			if (result) {
				return;
			} else {
				throw new Error();
			}
		});
}
