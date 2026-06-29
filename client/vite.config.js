import { defineConfig } from 'vite';
import autoprefixer from 'autoprefixer';
import postcssNested from 'postcss-nested';
import vue from '@vitejs/plugin-vue';

import { viteCommonjs } from '@originjs/vite-plugin-commonjs';
// import { visualizer } from 'rollup-plugin-visualizer';

import path from 'path';

const HOST = '127.0.0.1';

export default defineConfig(({ command, mode }) => {
	var config = {
		base: './',
		server: {
			host: HOST,
			port: process.env.PORT
		},
		publicDir: 'public',
		resolve: {
			alias: [
				{
					find: 'vue',
					replacement: 'vue/dist/vue.esm-bundler.js'
				},
				{
					find: 'node_modules/',
					replacement: `${path.resolve(__dirname, 'node_modules')}/`
				},
				{
					find: 'libs/',
					replacement: `${path.resolve(__dirname, 'libs')}/`
				},
				{
					find: 'js/',
					replacement: `${path.resolve(__dirname, 'js')}/`
				},
				{
					find: 'module/',
					replacement: `${path.resolve(__dirname, 'module')}/`
				},
				{
					find: 'css/',
					replacement: `${path.resolve(__dirname, 'css')}/`
				},
				{
					find: 'assets/',
					replacement: `${path.resolve(__dirname, 'assets')}/`
				}
			]
		},
		plugins: [
			vue({
				template: {
					compilerOptions: {
						whitespace: 'condense'
					}
				}
			}),
			viteCommonjs()
			// visualizer({})
		],
		css: {
			postcss: {
				plugins: [autoprefixer, postcssNested]
			}
		},
		build: {
			minify: true,
			commonjsOptions: {
				include: [/main.js/, /js/, /libs/, /module/],
				extensions: ['.js', '.cjs'],
				transformMixedEsModules: true,
				requireReturnsDefault: true
			},
			rollupOptions: {
				output: {
					entryFileNames: '[name].js'
				}
			},
			chunkSizeWarningLimit: 5000,
			outDir: './dist'
		},
		define: {}
	};
	if (command === 'serve') {
	} else {
	}
	return config;
});
