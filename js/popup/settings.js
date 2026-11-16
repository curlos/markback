import { state } from './state.js';
import { fetchUserSettings } from './helpers.js';
import {
	renderSpinnerCurrentVideoBookmarks,
	setCapturedFramesAndRender,
	renderBookmarkElementsForCurrentVideo,
} from './currentVideoBookmarks.js';
import { createCustomRadioButton } from './customRadioButton.js';
import { renderSidebarModalWithVideos } from './videosWithBookmarks.js';

const SORT_BY_OPTION_LIST = ['Most Recently Updated', 'Least Recently Updated', 'Most Bookmarks', 'Least Bookmarks'];

/**
 * @description Render the right "Settings" button that when clicked will open or close the "Settings" sidebar modal view.
 */
export const renderRightSettingsButton = () => {
	const settingsDiv = document.getElementById('settings-svg-wrapper');
	settingsDiv.innerHTML = getIconSVG('settings');
	settingsDiv.addEventListener('click', () => {
		toggleSettingsSidebarModal();
	});
};

const toggleSettingsSidebarModal = () => {
	const sidebarVideosWrapper = document.getElementById('sidebar-videos-wrapper');
	sidebarVideosWrapper.classList.remove('sidebar-shown');

	const sidebarSettingsWrapper = document.getElementById('sidebar-settings-wrapper');
	sidebarSettingsWrapper.classList.add('sidebar-transition-right');
	sidebarSettingsWrapper.classList.toggle('sidebar-shown-right');

	const isSidebarRightModalOpen = sidebarSettingsWrapper.classList.contains('sidebar-shown-right');

	if (isSidebarRightModalOpen) {
		document.querySelector('.title').textContent = 'Settings';
		return;
	}

	if (state.currentVideoId) {
		document.querySelector('.title').textContent = 'Bookmarks For This Video';
		return;
	}

	// If the sidebar settings modal is not open and there's no video id, then show the sidebar video list modal
	sidebarVideosWrapper.classList.add('sidebar-shown');
	document.querySelector('.title').textContent = 'Videos With Bookmarks';
};

/**
 * @description Render the "Settings" modal.
 */
export const renderSettingsModalContent = async () => {
	// NOTE: "fetchUserSettings" fills in the default value (DEFAULT_USER_SETTINGS in utils.js) for any setting that hasn't been set yet.
	await fetchUserSettings();

	renderSortByOptions();
	renderCheckboxCaptureFrames();
	renderCheckboxShowBookmarksProgressBar();
	renderCheckboxScrollNextBookmarkIntoView();
	renderCheckboxSplitVideoIntoParts();
	renderBackupButtons();
};

/**
 * @description Render the "Export Bookmarks" and "Import Bookmarks" buttons.
 */
const renderBackupButtons = () => {
	// Export: Download everything in Chrome's Storage (all videos with bookmarks and the user settings) as a JSON file.
	document.getElementById('export-bookmarks-button').onclick = async () => {
		const allItems = await chrome.storage.sync.get(null);
		const blob = new Blob([JSON.stringify(allItems, null, 2)], { type: 'application/json' });
		const date = new Date().toISOString().slice(0, 10);

		const linkElement = document.createElement('a');
		linkElement.href = URL.createObjectURL(blob);
		linkElement.download = `youtube-bookmarks-${date}.json`;
		linkElement.click();
		URL.revokeObjectURL(linkElement.href);
	};

	// Import: Open the import page in a new tab. This can't be done in the popup itself because the popup closes as soon as the file picker opens.
	document.getElementById('import-bookmarks-button').onclick = () => {
		chrome.tabs.create({ url: chrome.runtime.getURL('import.html') });
	};
};

const renderCheckboxCaptureFrames = () => {
	const checkboxCaptureFramesElement = document.getElementById('checkbox-capture-frames');
	checkboxCaptureFramesElement.checked = state.userSettings.captureFrames ? true : false;

	checkboxCaptureFramesElement.addEventListener('click', async (e) => {
		const isChecked = e.target.checked;

		await chrome.storage.sync.set({
			userSettings: JSON.stringify({
				...state.userSettings,
				captureFrames: isChecked,
			}),
		});

		await fetchUserSettings();

		if (isChecked) {
			// If "Capture Frames" is checked, then show the loading spinner and send the message to content script to capture frames at the specified timestamps.
			renderSpinnerCurrentVideoBookmarks();
			setCapturedFramesAndRender();
		} else {
			await renderBookmarkElementsForCurrentVideo();
		}
	});
};

const renderCheckboxShowBookmarksProgressBar = () => {
	const checkboxShowBookmarksProgressBarElement = document.getElementById('checkbox-show-bookmarks-progress-bar');
	checkboxShowBookmarksProgressBarElement.checked = state.userSettings.showBookmarksProgressBar ? true : false;

	checkboxShowBookmarksProgressBarElement.addEventListener('click', async (e) => {
		const isChecked = e.target.checked;

		await chrome.storage.sync.set({
			userSettings: JSON.stringify({
				...state.userSettings,
				showBookmarksProgressBar: isChecked,
			}),
		});

		await fetchUserSettings();
		await renderBookmarkElementsForCurrentVideo();
	});
};

const renderCheckboxScrollNextBookmarkIntoView = () => {
	const checkboxScrollNextBookmarkIntoViewElement = document.getElementById(
		'checkbox-scroll-next-bookmark-into-view'
	);
	checkboxScrollNextBookmarkIntoViewElement.checked = state.userSettings.scrollNextBookmarkIntoView ? true : false;

	checkboxScrollNextBookmarkIntoViewElement.addEventListener('click', async (e) => {
		const isChecked = e.target.checked;

		await chrome.storage.sync.set({
			userSettings: JSON.stringify({
				...state.userSettings,
				scrollNextBookmarkIntoView: isChecked,
			}),
		});

		await fetchUserSettings();
		await renderBookmarkElementsForCurrentVideo();
	});
};

const renderCheckboxSplitVideoIntoParts = () => {
	const checkboxSplitVideoIntoPartsElement = document.getElementById('checkbox-split-video-into-parts');
	checkboxSplitVideoIntoPartsElement.checked = state.userSettings.splitVideoIntoParts ? true : false;

	checkboxSplitVideoIntoPartsElement.addEventListener('click', async (e) => {
		const isChecked = e.target.checked;

		await chrome.storage.sync.set({
			userSettings: JSON.stringify({
				...state.userSettings,
				splitVideoIntoParts: isChecked,
			}),
		});

		// Update the user settings in Content Script so that the "editVideoProgressBarAndTimeVisually" function can use the latest "userSettings.splitVideoIntoParts" value.
		// This fails on non-YouTube tabs (there's no content script there), which is fine.
		await chrome.tabs.sendMessage(state.activeTab.id, { type: 'update-user-settings' }).catch(() => {});

		await fetchUserSettings();
		await renderBookmarkElementsForCurrentVideo();
	});
};

const renderSortByOptions = async () => {
	const sortByOptionsElem = document.querySelector('.sort-by-options');
	sortByOptionsElem.innerHTML = '';

	SORT_BY_OPTION_LIST.forEach((sortByOption) => {
		// Create multiple radio buttons
		const radio1 = createCustomRadioButton({
			label: sortByOption,
			// All options share one name so they work as a single group (Tab reaches the group once and the arrow keys move between the options).
			name: 'sort-by',
			checked: state.userSettings.sortBy === sortByOption,
			onChange: async () => {
				state.userSettings.sortBy = sortByOption;
				await updateUserSettings(state.userSettings);
				await renderSortByOptions();
				// Re-rendering removes the focused option, so put the keyboard focus back on the newly selected one.
				sortByOptionsElem.querySelector('.radio-input:checked').focus();
				await renderSidebarModalWithVideos();
			},
		});

		sortByOptionsElem.appendChild(radio1);
	});
};

const updateUserSettings = async (newUserSettings) => {
	await chrome.storage.sync.set({
		userSettings: JSON.stringify(newUserSettings),
	});

	await fetchUserSettings();
};
