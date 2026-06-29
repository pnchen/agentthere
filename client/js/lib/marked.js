import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

var _hljs = null;
import('highlight.js').then(({ default: hljs }) => {
	_hljs = hljs;
	window.hljs = hljs;
	import('highlightjs-line-numbers.js').then(() => {});
});

const renderer = {
	link(href, title, text) {
		var t = title ? ` title="${title}"` : '';
		return `<a href="${href}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
	}
};

var marked = new Marked(
	markedHighlight({
		langPrefix: 'hljs language-',
		highlight(code, lang) {
			if (!_hljs) return code;
			var result = _hljs.getLanguage(lang) ? _hljs.highlight(code, { language: lang }) : _hljs.highlightAuto(code);
			return result.value;
		}
	})
);
marked.use({ renderer });

export default function (input) {
	return marked.parse(input || '');
}
