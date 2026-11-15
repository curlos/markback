/**
 * @filename dev-reload-server.js
 * @description Development only. Watches the extension's files and tells background.js to reload the extension whenever a file is saved. Run with "npm run dev".
 */

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 35729;
const WATCHED_PATHS = ['js', 'css', 'assets', 'popup.html', 'import.html', 'manifest.json'];

const server = new WebSocketServer({ port: PORT });
let reloadTimeoutId = null;

/**
 * @description Tell every connected extension to reload. Waits a moment so that saving several files at once only causes one reload.
 */
const sendReload = () => {
	clearTimeout(reloadTimeoutId);

	reloadTimeoutId = setTimeout(() => {
		server.clients.forEach((client) => client.send('reload'));
		console.log(`[dev-reload] Reloaded extension (${server.clients.size} connected)`);
	}, 200);
};

WATCHED_PATHS.forEach((watchedPath) => {
	fs.watch(path.join(__dirname, '..', watchedPath), { recursive: true }, sendReload);
});

server.on('connection', () => console.log('[dev-reload] Extension connected'));

console.log(`[dev-reload] Watching for changes on ws://localhost:${PORT}`);
