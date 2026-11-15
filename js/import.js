/**
 * @filename import.js
 * @description Import bookmarks from a JSON file that was exported with the "Export Bookmarks" button in the popup's settings. This is a separate page (instead of being in the popup) because the popup closes as soon as the file picker opens.
 */

const fileInputElem = document.getElementById('import-file-input');
const messageElem = document.getElementById('import-message');

/**
 * @description Show a success or error message under the file input.
 * @param {String} text
 * @param {Boolean} isError
 */
const showMessage = (text, isError = false) => {
	messageElem.textContent = text;
	messageElem.className = isError ? 'import-message import-error' : 'import-message import-success';
};

/**
 * @description Check that an item from the file looks like a video with bookmarks (a JSON string with a "bookmarks" array where every bookmark has a numeric "time").
 * @param {any} value
 * @returns {Boolean}
 */
const isValidVideoItem = (value) => {
	try {
		const videoObj = JSON.parse(value);
		return (
			Array.isArray(videoObj.bookmarks) &&
			videoObj.bookmarks.every((bookmark) => bookmark && typeof bookmark.time === 'number')
		);
	} catch {
		return false;
	}
};

/**
 * @description Check that the user settings from the file are a JSON string of an object (anything else would break the popup).
 * @param {any} value
 * @returns {Boolean}
 */
const isValidUserSettings = (value) => {
	try {
		const settingsObj = JSON.parse(value);
		return !!settingsObj && typeof settingsObj === 'object' && !Array.isArray(settingsObj);
	} catch {
		return false;
	}
};

fileInputElem.addEventListener('change', async () => {
	const file = fileInputElem.files[0];

	if (!file) {
		return;
	}

	let items;

	try {
		items = JSON.parse(await file.text());
	} catch {
		showMessage('This file is not valid JSON. Please choose a file exported from this extension.', true);
		return;
	}

	if (!items || typeof items !== 'object' || Array.isArray(items)) {
		showMessage('This file does not look like an export from this extension.', true);
		return;
	}

	// Only import the user settings and the items that look like videos with bookmarks. Skip anything else.
	const itemsToImport = {};

	Object.entries(items).forEach(([key, value]) => {
		if (key === 'userSettings' ? isValidUserSettings(value) : isValidVideoItem(value)) {
			itemsToImport[key] = value;
		}
	});

	const numOfVideos = Object.keys(itemsToImport).filter((key) => key !== 'userSettings').length;

	if (numOfVideos === 0) {
		showMessage('No videos with bookmarks were found in this file.', true);
		return;
	}

	try {
		await chrome.storage.sync.set(itemsToImport);
		showMessage(
			`Imported ${numOfVideos} ${numOfVideos === 1 ? 'video' : 'videos'} with bookmarks. You can close this tab.`
		);
	} catch (error) {
		// Chrome's Sync Storage is small (100KB total and 8KB per video) so a big import can go over the limit.
		showMessage(`Could not import the bookmarks: ${error.message}`, true);
	}
});
