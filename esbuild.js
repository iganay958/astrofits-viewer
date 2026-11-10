const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const common = {
		bundle: true,
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	};
	const contexts = await Promise.all([
		// Extension host (Node).
		esbuild.context({
			...common,
			entryPoints: ['src/extension.ts'],
			format: 'cjs',
			platform: 'node',
			outfile: 'dist/extension.js',
			external: ['vscode'],
		}),
		// Webview UI (browser).
		esbuild.context({
			...common,
			entryPoints: ['src/webview/main.ts'],
			format: 'iife',
			platform: 'browser',
			target: 'es2022',
			outfile: 'dist/webview.js',
		}),
	]);
	for (const ctx of contexts) {
		if (watch) {
			await ctx.watch();
		} else {
			await ctx.rebuild();
			await ctx.dispose();
		}
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
