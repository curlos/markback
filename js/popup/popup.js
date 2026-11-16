import { state } from './state.js';
import { renderSpinnerCurrentVideoBookmarks, setCapturedFramesAndRender } from './currentVideoBookmarks.js';
import { renderLeftMenuButton, renderSidebarModalWithVideos } from './videosWithBookmarks.js';
import { renderRightSettingsButton, renderSettingsModalContent } from './settings.js';

/**
 * @description Only the view that is showing (the current video's bookmarks, the "Videos With Bookmarks" sidebar or the "Settings" sidebar) can be clicked or reached with the Tab key. The hidden ones are made "inert" since they're only moved off screen or covered, not removed.
 */
const updateInertViews = () => {
	const sidebarVideosWrapper = document.getElementById('sidebar-videos-wrapper');
	const sidebarSettingsWrapper = document.getElementById('sidebar-settings-wrapper');
	const isVideosSidebarOpen = sidebarVideosWrapper.classList.contains('sidebar-shown');
	const isSettingsSidebarOpen = sidebarSettingsWrapper.classList.contains('sidebar-shown-right');

	sidebarVideosWrapper.inert = !isVideosSidebarOpen;
	sidebarSettingsWrapper.inert = !isSettingsSidebarOpen;
	document.getElementById('bookmarks').inert = isVideosSidebarOpen || isSettingsSidebarOpen;
};

/**
 * @description Once the DOM Content has loaded, check if we're on a YouTube video page and if we are, get all the bookmarks for that video and show them.
 */
document.onreadystatechange = async () => {
	if (document.readyState === 'complete') {
		// The sidebars are opened and closed by toggling their classes in several places, so update which view is inert whenever those classes change.
		const sidebarObserver = new MutationObserver(updateInertViews);
		['sidebar-videos-wrapper', 'sidebar-settings-wrapper'].forEach((id) => {
			sidebarObserver.observe(document.getElementById(id), { attributes: true, attributeFilter: ['class'] });
		});
		updateInertViews();

		const activeTab = await getActiveTab();
		state.activeTab = activeTab;

		// "url" is only available for YouTube tabs (from "host_permissions"), so it's undefined on other websites.
		const queryParams = (activeTab.url || '').split('?')[1];
		const urlParams = new URLSearchParams(queryParams);

		const isYouTubeFullVideo = activeTab.url && activeTab.url.includes('youtube.com/watch');
		const isYouTubeShortsVideo = activeTab.url && activeTab.url.includes('youtube.com/shorts');
		const isYouTubeVideo = isYouTubeFullVideo || isYouTubeShortsVideo;

		if (isYouTubeVideo) {
			state.currentVideoId = isYouTubeFullVideo ? urlParams.get('v') : getYouTubeShortsVideoId(activeTab.url);
		}

		clearInterval(state.video.intervalId);
		state.video.intervalId = null;

		if (isYouTubeVideo && state.currentVideoId) {
			// Render everything including the bookmarks for the current video.
			renderSpinnerCurrentVideoBookmarks();
			renderLeftMenuButton();
			renderRightSettingsButton();
			renderSidebarModalWithVideos();
			renderSettingsModalContent();

			waitForContentScriptWithInterval(activeTab.id, () => {
				setCapturedFramesAndRender();

				state.video.intervalId = setInterval(() => {
					chrome.tabs.sendMessage(
						state.activeTab.id,
						{ type: 'content-get-current-video-time-and-duration' },
						{},
						(videoCurrentTimeAndDuration) => {
							if (!videoCurrentTimeAndDuration) {
								return;
							}

							const { currentTime, duration } = videoCurrentTimeAndDuration;
							const firstBookmark = state.currentVideoBookmarks[0];
							const videoRestarted =
								currentTime < state.video.currentTime - 1 &&
								firstBookmark &&
								currentTime < firstBookmark.time;

							// If the video restarted (for example, a Short looping back to the start), scroll back to the first bookmark at the top.
							if (videoRestarted && state.userSettings && state.userSettings.scrollNextBookmarkIntoView) {
								document.getElementById('bookmarks').scrollTo({ top: 0, behavior: 'smooth' });
							}

							state.video.currentTime = currentTime;
							state.video.duration = duration;
						}
					);
				}, 100);
			});
		} else {
			// If it's not a YouTube video, then render everything but the list of bookmarks for a specific video.
			renderLeftMenuButton();
			renderRightSettingsButton();
			renderSidebarModalWithVideos();
			renderSettingsModalContent();

			// By default, when the popup is opened on a non-YouTube video page, show the list of videos that have been bookmarked at least once.
			document.querySelector('.sidebar-modal').classList.add('sidebar-shown');
			document.querySelector('.title').textContent = 'Videos With Bookmarks';
		}
	}
};
