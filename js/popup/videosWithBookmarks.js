import { state } from './state.js';
import { getAllVideosWithBookmarks, handleFilteredBookmarks, fetchUserSettings } from './helpers.js';

/**
 * @description Renders the left "menu" button that when clicked will open or close the "Videos With Bookmarks" sidebar modal.
 */
export const renderLeftMenuButton = () => {
	const menuDiv = document.getElementById('menu-svg-wrapper');
	menuDiv.innerHTML = getIconSVG('menu');
	menuDiv.addEventListener('click', () => {
		toggleVideosWithBookmarksSidebarModal();
	});
};

const toggleVideosWithBookmarksSidebarModal = () => {
	const sidebarSettingsWrapper = document.getElementById('sidebar-settings-wrapper');
	sidebarSettingsWrapper.classList.remove('sidebar-shown-right');

	const sidebarVideosWrapper = document.getElementById('sidebar-videos-wrapper');
	sidebarVideosWrapper.classList.add('sidebar-transition');
	sidebarVideosWrapper.classList.toggle('sidebar-shown');

	const isSidebarModalOpen = sidebarVideosWrapper.classList.contains('sidebar-shown');

	if (isSidebarModalOpen) {
		document.querySelector('.title').textContent = 'Videos With Bookmarks';
		return;
	}

	if (state.currentVideoId) {
		document.querySelector('.title').textContent = 'Bookmarks For This Video';
		return;
	}

	// If the sidebar video list modal is not open and there's no video id, then show the settings sidebar modal
	sidebarSettingsWrapper.classList.add('sidebar-shown-right');
	document.querySelector('.title').textContent = 'Settings';
};

/**
 * @description Render a sidebar modal that shows a list of videos with their thumbnail image, title, and number of bookmarks.
 */
export const renderSidebarModalWithVideos = async () => {
	const sidebarVideoListElem = document.querySelector('.sidebar-video-list');

	await fetchUserSettings();
	await getAllVideosWithBookmarks();

	// Clear the list only after the awaits above so that two renders running at the same time (like changing the sort quickly) can't both add their videos.
	sidebarVideoListElem.innerHTML = '';

	// Sort the videos from most recently updated to least recently updated.
	const sortedVideosWithBookmarksVideoIds = Object.keys(state.allVideosWithBookmarks).sort((a, b) => {
		const objA = JSON.parse(state.allVideosWithBookmarks[a]);
		const objB = JSON.parse(state.allVideosWithBookmarks[b]);

		const dateA = new Date(objA.updatedAt);
		const dateB = new Date(objB.updatedAt);

		const numOfBookmarksA = objA.bookmarks.length;
		const numOfBookmarksB = objB.bookmarks.length;

		switch (state.userSettings.sortBy) {
			case 'Most Recently Updated':
				return dateB - dateA;
			case 'Least Recently Updated':
				return dateA - dateB;
			case 'Most Bookmarks':
				return numOfBookmarksB - numOfBookmarksA;
			case 'Least Bookmarks':
				return numOfBookmarksA - numOfBookmarksB;
			default:
				// By default, sort by most recently updated first.
				return dateB - dateA;
		}
	});

	if (sortedVideosWithBookmarksVideoIds.length === 0) {
		sidebarVideoListElem.innerHTML = '<i class="row">No videos with bookmarks yet</i>';
		return;
	}

	// Go through all the videos and render the thumbnail image, video title, and the number of bookmarks for that video.
	sortedVideosWithBookmarksVideoIds.forEach((videoId) => {
		const videoWithBookmarksElem = getVideoWithBookmarksElem(videoId);
		sidebarVideoListElem.appendChild(videoWithBookmarksElem);
	});

	renderDeleteAllBookmarksButton();
};

const getVideoWithBookmarksElem = (videoId) => {
	const video = JSON.parse(state.allVideosWithBookmarks[videoId]);

	const videoWithBookmarksElem = document.createElement('div');
	videoWithBookmarksElem.className = 'video-with-bookmarks';

	const thumbnailImageElement = document.createElement('img');
	// Build the thumbnail from the video ID so it's always the right one. "hqdefault" works for both videos and Shorts (Shorts get their thumbnail in the middle with blurred sides).
	thumbnailImageElement.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
	// Empty "alt" because the title next to the thumbnail already names the video.
	thumbnailImageElement.alt = '';

	const videoInfoElem = document.createElement('div');

	// A button so that keyboard users can reach it. Its click bubbles up to the video container's click listener below.
	const titleElement = document.createElement('button');
	titleElement.textContent = video.title;
	titleElement.className = 'video-with-bookmarks-title reset-button';

	const bookmarksNumberElement = document.createElement('div');
	bookmarksNumberElement.textContent =
		video.bookmarks.length > 1 ? `${video.bookmarks.length} Bookmarks` : `${video.bookmarks.length} Bookmark`;

	const deleteIconOuterWrapper = document.createElement('div');
	deleteIconOuterWrapper.className = 'delete-icon-outer-wrapper';

	const deleteIconInnerWrapper = document.createElement('button');
	deleteIconInnerWrapper.className = 'delete-icon-inner-wrapper reset-button';
	deleteIconInnerWrapper.setAttribute('aria-label', 'Delete bookmarks for this video');
	deleteIconInnerWrapper.innerHTML = getIconSVG('delete');

	deleteIconInnerWrapper.addEventListener('click', async (e) => {
		e.stopPropagation();
		await chrome.storage.sync.remove(videoId);
		await handleFilteredBookmarks();
	});

	deleteIconOuterWrapper.appendChild(deleteIconInnerWrapper);

	videoInfoElem.appendChild(titleElement);
	videoInfoElem.appendChild(bookmarksNumberElement);
	videoInfoElem.appendChild(deleteIconOuterWrapper);

	videoWithBookmarksElem.appendChild(thumbnailImageElement);
	videoWithBookmarksElem.appendChild(videoInfoElem);

	// When the video container is clicked, navigate to that video's page.
	videoWithBookmarksElem.addEventListener('click', async () => {
		const videoURL =
			video.videoType === 'shorts'
				? `https://www.youtube.com/shorts/${videoId}`
				: `https://www.youtube.com/watch?v=${videoId}`;
		const activeTab = await getActiveTab();

		if (state.currentVideoId !== videoId) {
			chrome.tabs.update(activeTab.id, {
				url: videoURL,
			});
		}

		// Close the popup after navigating to the new video page.
		window.close();
	});

	return videoWithBookmarksElem;
};

/**
 * @description Render the "Delete All Bookmarks" button at the bottom of the "Video With Bookmarks" sidebar modal view. When clicked, it will remove all videos and their bookmarks from the Chrome Storage.
 */
const renderDeleteAllBookmarksButton = () => {
	// NOTE: Only called by "renderSidebarModalWithVideos" after it has checked that there are videos with bookmarks.
	const sidebarVideoListElem = document.querySelector('.sidebar-video-list');

	const deleteAllBookmarksButtonWrapper = document.createElement('div');
	deleteAllBookmarksButtonWrapper.className = 'delete-all-bookmarks-button-wrapper';

	const deleteAllBookmarksButton = document.createElement('button');
	deleteAllBookmarksButton.className = 'delete-all-bookmarks-button';
	deleteAllBookmarksButton.textContent = 'Delete All Bookmarks';

	// Listen on the button itself (not the full-width wrapper) so that clicking the empty space around it doesn't delete everything.
	deleteAllBookmarksButton.addEventListener('click', async () => {
		const videoIdsToRemove = Object.keys(state.allVideosWithBookmarks);
		await Promise.all(videoIdsToRemove.map((videoId) => chrome.storage.sync.remove(videoId)));
		await handleFilteredBookmarks();
	});

	deleteAllBookmarksButtonWrapper.appendChild(deleteAllBookmarksButton);
	sidebarVideoListElem.appendChild(deleteAllBookmarksButtonWrapper);
};
