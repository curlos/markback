/**
 * @filename background.js
 * @description Service Worker that runs in the background and listens for messages from contentScript.js and popup.js. The three main JS files in this project run in 3 different environments/contexts for each one with a separate devtools window for each (background.js, contentScript.js, popup.js).
 */

/**
 * @description Listen for messages from contentScript.js and popup.js
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	switch (message.type) {
		case 'open-popup':
			// Tell the content script whether the popup opened. It can fail to open (for example, when the video is in fullscreen mode).
			chrome.action
				.openPopup()
				.then(() => sendResponse(true))
				.catch(() => sendResponse(false));
			return true;
		case 'background-get-current-video-bookmarks-with-frames':
			getCurrentVideoBookmarksWithFrames(sendResponse);
			return true;
	}
});

/**
 * @description Get the active tab.
 * @param {Function} sendResponse
 * @returns {Object}
 */
async function getActiveTab(sendResponse) {
	const tabs = await chrome.tabs.query({
		currentWindow: true,
		active: true,
	});

	if (sendResponse) {
		sendResponse(tabs[0]);
	}

	return tabs[0];
}

/**
 * @description Sends a message to contentScript.js that will eventually give it the captured visual frames of the different bookmarked timestamps for the current video. This is sent back to popup.js to display these frames.
 * @param {Function} sendResponse Chrome has this weird system for sending responses back with async/await functions instead of just returning the response so the only way I got this to properly work was doing it this way by passing in "sendResponse". Got this idea from a StackOverflow answer here: https://stackoverflow.com/questions/14094447/chrome-extension-dealing-with-asynchronous-sendmessage
 */
const getCurrentVideoBookmarksWithFrames = async (sendResponse) => {
	const activeTab = await getActiveTab();

	waitForContentScriptWithInterval(activeTab.id, () => {
		chrome.tabs.sendMessage(
			activeTab.id,
			{ type: 'content-get-current-video-bookmarks-with-frames' },
			{},
			(response) => {
				if (chrome.runtime.lastError) {
					console.error('Error sending message to tab:', chrome.runtime.lastError.message);
				} else {
					sendResponse(response);
				}
			}
		);
	});
};

const waitForContentScriptWithInterval = (tabId, callback) => {
	// Set up a variable to track the interval ID
	const intervalId = setInterval(() => {
		chrome.tabs.sendMessage(
			tabId,
			{ type: 'check-ready' }, // Message to check readiness
			(response) => {
				if (chrome.runtime.lastError || !response?.ready) {
					// Content script is not ready yet, continue polling
					return;
				}

				// Content script is ready, clear the interval
				clearInterval(intervalId);

				// Proceed with the actual message
				callback();
			}
		);
	}, 100); // Check every 100ms
};

/**
 * @description Development only: auto-reload the extension when a file is saved while "npm run dev" is running. "installType" is "development" only when the extension is loaded unpacked from a folder, so this never runs for users who installed it from the Chrome Web Store.
 */
const isDevelopment = chrome.management.getSelf().then((extensionInfo) => extensionInfo.installType === 'development');

const connectToDevReloadServer = () => {
	const socket = new WebSocket('ws://localhost:35729');
	// Sending a message every 20 seconds keeps the service worker (and this connection) alive.
	const keepAliveIntervalId = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('ping'), 20000);

	socket.onmessage = (event) => event.data === 'reload' && chrome.runtime.reload();
	socket.onclose = () => {
		// The dev server isn't running (or stopped), so try again in a few seconds.
		clearInterval(keepAliveIntervalId);
		setTimeout(connectToDevReloadServer, 3000);
	};
};

isDevelopment.then((isDev) => isDev && connectToDevReloadServer());

// After the extension reloads, the content script in already open YouTube tabs is outdated, so refresh those tabs. This listener has to be added right away (not after an "await") or Chrome can miss the event.
chrome.runtime.onInstalled.addListener(async () => {
	if (!(await isDevelopment)) {
		return;
	}

	const youTubeTabs = await chrome.tabs.query({ url: 'https://*.youtube.com/*' });
	youTubeTabs.forEach((tab) => chrome.tabs.reload(tab.id));
});
