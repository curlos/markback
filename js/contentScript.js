// This is needed to get async/await working with "chrome.runtime.onMessage.addListener". Chrome still doesn't support Promise in the returned value of onMessage listener both in ManifestV3 and V2. This code is from StackOverflow: https://stackoverflow.com/questions/53024819/sendresponse-not-waiting-for-async-function-or-promises-resolve
const { onMessage } = chrome.runtime;
const { addListener } = chrome.runtime.onMessage;

onMessage.addListener = (fn) =>
	addListener.call(onMessage, (msg, sender, respond) => {
		const res = fn(msg, sender, respond);
		if (res instanceof Promise) return !!res.then(respond, console.error);
		if (res !== undefined) respond(res);
	});

// Global Variables
let youtubeRightControls = null;
let videoElem = null;
let currentVideoId = '';
// "currentVideoType" can either be "watch" or "shorts".
let currentVideoType = '';
let currentVideoBookmarks = [];
let currentVideoFullObj = null;
let userSettings = null;
// Whether the player's time text is YouTube's own (true) or has been edited by us to show the current "part" (false). It's not reset on navigation so that edits left over from the previous video still get undone.
let timestampTextBackToNormal = true;
// The captured frames for the bookmarks of a video. Cached here (instead of in background.js) because the content script lives as long as the tab while the background service worker can be stopped by Chrome at any time.
let cachedBookmarksWithFrames = { videoId: null, bookmarksWithFrames: null };
// The "timeupdate" listener that edits the video's progress bar and time. Stored so that it's only ever added once.
let handleTimeUpdate = null;

/**
 * @description Fetch the array of bookmarks for the current video. If no bookmarks, will return an empty array.
 * @returns {Array<Object>}
 */
const fetchBookmarks = async () => {
	// Always read the video id from the URL so that we never use a stale id from a previous video.
	await getCurrentVideoId();

	if (!currentVideoId) {
		currentVideoBookmarks = [];
		currentVideoFullObj = null;
		return;
	}

	const obj = await chrome.storage.sync.get(currentVideoId);
	currentVideoFullObj = obj[currentVideoId] ? JSON.parse(obj[currentVideoId]) : null;
	currentVideoBookmarks = currentVideoFullObj ? currentVideoFullObj.bookmarks : [];
};

/**
 * @description Add a new bookmark to the current video using the current time.
 */
const handleAddNewBookmark = async () => {
	const bookmarkButtons = Array.from(document.querySelectorAll('.bookmark-btn'));
	bookmarkButtons.forEach((bookmarkButton) => {
		bookmarkButton.disabled = true;
	});

	try {
		if (!videoElem) {
			videoElem = await getAndWaitForVideoToExist();
		}

		const currentTime = videoElem.currentTime;
		const newBookmark = {
			time: currentTime,
			note: '',
		};

		await fetchBookmarks();
		const newCurrentVideoBookmarks = [...currentVideoBookmarks, newBookmark].sort((a, b) => a.time - b.time);

		// Remove YouTube's notification count (like "(795) ") and " - YouTube" from the page title.
		const title = ((currentVideoFullObj && currentVideoFullObj.title) || document.title)
			.replace(/^\(\d+\)\s*/, '')
			.replace(/\s*-\s*YouTube$/, '');
		// Always build the thumbnail from the video ID so that a wrong thumbnail saved by an older version gets replaced.
		const thumbnailImageSrc = getThumbnailUrl();
		const videoType = currentVideoType;

		const newCurrentVideoBookmarksStr = JSON.stringify({
			bookmarks: newCurrentVideoBookmarks,
			title,
			thumbnailImageSrc,
			videoType,
			updatedAt: new Date(),
		});

		await chrome.storage.sync.set({
			[currentVideoId]: newCurrentVideoBookmarksStr,
		});

		// Get the updated bookmarks with the newly added one.
		await fetchBookmarks();

		// Play a short animation on the bookmark buttons to show that the bookmark was added.
		bookmarkButtons.forEach((bookmarkButton) => {
			bookmarkButton.classList.add('bookmark-btn-saved');
		});

		// Open the popup after adding the bookmark to show it in the list of bookmarks. The popup can fail to open (for example, when the video is in fullscreen).
		await chrome.runtime.sendMessage({ type: 'open-popup' });
	} catch (error) {
		// For example, Chrome's Sync Storage limit (8KB per video) was reached.
		console.error('Could not add the bookmark:', error);
	} finally {
		bookmarkButtons.forEach((bookmarkButton) => {
			bookmarkButton.disabled = false;
		});
	}
};

/**
 * @description Gets the thumbnail's image URL for a video.
 * @returns {String}
 */
const getThumbnailUrl = () => {
	if (currentVideoType === 'watch') {
		// Build the thumbnail URL from the video id. This is always correct for the current video, unlike reading it from the page's DOM which could be stale or fail to parse.
		return `https://i.ytimg.com/vi/${currentVideoId}/hqdefault.jpg`;
	}

	if (currentVideoType === 'shorts') {
		// This doesn't technically get the thumbnail but rather the first frame of the video "frame0". It's possible to get the thumbnail of a short in the elements but as soon as you scroll to the next short, that DOM element will become stale and will reference the previous short (or the first short). Thus, the most reliable "thumbnail" image is the first frame of the video.
		return `https://i.ytimg.com/vi/${currentVideoId}/frame0.jpg`;
	}

	return '';
};

/**
 * @description When a new video is loaded, get that video's bookmarks and add the bookmark button to the video player's right controls if it hasn't been added yet.
 * @param {Number} shortsRetriesLeft How many more times to check for the Shorts action bar.
 */
const addBookmarkButtonToVideo = async (shortsRetriesLeft = 10) => {
	await fetchBookmarks();

	if (currentVideoId) {
		if (!videoElem) {
			videoElem = await getAndWaitForVideoToExist();
		}

		// NOTE: The checks for an existing bookmark button happen here (after the awaits above) instead of before them. This function can be called multiple times at once and checking before the awaits would let each call add its own button.
		switch (currentVideoType) {
			case 'watch':
				// Add the bookmark button to the "right" controls of the main video player ("#movie_player"). In YouTube's newer player, the right controls are split into a left and right group so use the left group if it exists.
				youtubeRightControls =
					document.querySelector('#movie_player .ytp-right-controls-left') ||
					document.querySelector('#movie_player .ytp-right-controls');

				if (youtubeRightControls && !document.querySelector('#movie_player .bookmark-btn')) {
					const bookmarkBtnElement = createAndGetBookmarkBtnElement();
					youtubeRightControls.insertBefore(bookmarkBtnElement, youtubeRightControls.firstChild);
				}
				break;
			case 'shorts':
				// "Shorts" have their own action bar (like, comment, share, etc.) for each short loaded on the page. Go through ALL of the action bars and add the bookmark button to all of the ones that don't have it yet.
				const actionBarElemList = Array.from(document.querySelectorAll('reel-action-bar-view-model'));

				actionBarElemList.forEach((actionBarElem) => {
					const hasBookmarkBtn = actionBarElem.querySelector('.bookmark-btn');

					if (!hasBookmarkBtn) {
						// A new bookmark element has to be created for each action bar.
						const bookmarkBtnElement = createAndGetBookmarkBtnElement();
						actionBarElem.insertBefore(bookmarkBtnElement, actionBarElem.firstChild);
					}
				});

				// YouTube renders the action bar a moment after navigating and replaces it for every new short, so keep checking for a few seconds.
				if (shortsRetriesLeft > 0) {
					setTimeout(() => addBookmarkButtonToVideo(shortsRetriesLeft - 1), 500);
				}
		}
	}
};

/**
 * @description Creates and gets the bookmark SVG icon HTML Button element.
 * @returns {HTMLButtonElement}
 */
const createAndGetBookmarkBtnElement = () => {
	const bookmarkSvgContainer = document.createElement('button');

	bookmarkSvgContainer.className = 'ytp-button bookmark-btn';
	bookmarkSvgContainer.title = 'Bookmark this timestamp';
	bookmarkSvgContainer.addEventListener('click', handleAddNewBookmark);
	// Remove the "saved" animation class once it finishes so that it can play again next time.
	bookmarkSvgContainer.addEventListener('animationend', () => {
		bookmarkSvgContainer.classList.remove('bookmark-btn-saved');
	});
	// A bookmark ribbon with a red clock (like the extension's icon) so it doesn't look like YouTube's own "Save" button. It's 24x24 like YouTube's other player icons.
	bookmarkSvgContainer.innerHTML = `
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
			<path class="bookmark-btn-ribbon" d="M5 3.5A1.5 1.5 0 0 1 6.5 2h9A1.5 1.5 0 0 1 17 3.5V21l-6-4-6 4z" fill="none" stroke="white" stroke-width="2" stroke-linejoin="round" />
			<circle cx="17.5" cy="16.5" r="5" fill="#ff0033" />
			<path d="M17.5 13.8v2.7l1.8 1.1" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
		</svg>`;

	return bookmarkSvgContainer;
};

// Listen to messages from background.js
chrome.runtime.onMessage.addListener(async (obj) => {
	const { type, value } = obj;

	switch (type) {
		case 'check-ready':
			return { ready: true };
		// For popup.js
		case 'play-new-timestamp-in-video':
			videoElem.currentTime = value;

			if (videoElem.paused) {
				videoElem.play();
			}

			// Once we go to that time in the video, show the timestamp progress bar for a second before hiding it again.
			const html5VideoPlayerElem = document.querySelector('.html5-video-player');
			html5VideoPlayerElem.classList.remove('ytp-autohide');

			setTimeout(() => {
				html5VideoPlayerElem.classList.add('ytp-autohide');
			}, 1000);

			break;
		// For popup.js
		case 'content-get-current-video-bookmarks-with-frames':
			await fetchUserSettings();
			await fetchBookmarks();
			addBookmarkButtonToVideo();

			const bookmarkButtons = Array.from(document.querySelectorAll('.bookmark-btn'));

			// If we don't need to capture frames, then return the current bookmarks. These bookmarks will have no "thumbnailImageSrc".
			if (!userSettings.captureFrames) {
				bookmarkButtons.forEach((bookmarkButton) => {
					bookmarkButton.disabled = false;
				});
				return currentVideoBookmarks;
			}

			// Only use the cached frames if they belong to the current video.
			const currentVideoBookmarksWithFrames =
				cachedBookmarksWithFrames.videoId === currentVideoId
					? cachedBookmarksWithFrames.bookmarksWithFrames
					: null;

			if (!videoElem) {
				videoElem = await getAndWaitForVideoToExist();
			}

			// Capturing frames moves the video to each bookmark's time, so don't allow adding a bookmark until it's done.
			bookmarkButtons.forEach((bookmarkButton) => {
				bookmarkButton.disabled = true;
			});

			await waitForVideoToBeReady(videoElem);

			const timestampBeforeCapturing = videoElem.currentTime;

			const newCurrentVideoBookmarksWithFrames = [];

			const currentVideoBookmarksWithFramesByTime =
				currentVideoBookmarksWithFrames && arrayToObjectByKey(currentVideoBookmarksWithFrames, 'time', true);

			let capturedAtLeastOneFrame = false;

			// Go through the array of video bookmarks and use their "time" and the video element, go and capture the frame of the video at each "time" and store the dataUrl of these frames in a new array.
			for (let i = 0; i < currentVideoBookmarks.length; i++) {
				const bookmark = currentVideoBookmarks[i];
				const bookmarkTimeKey = Math.floor(bookmark.time);

				const alreadyHasFrame =
					currentVideoBookmarksWithFramesByTime &&
					currentVideoBookmarksWithFramesByTime[bookmarkTimeKey] &&
					currentVideoBookmarksWithFramesByTime[bookmarkTimeKey].dataUrl;

				// If we already have the captured frame for the bookmark at that time, then use the cached frame.
				if (alreadyHasFrame) {
					const bookmarkWithFrame = currentVideoBookmarksWithFramesByTime[bookmarkTimeKey];
					newCurrentVideoBookmarksWithFrames.push(bookmarkWithFrame);
					continue;
				}

				try {
					const dataUrl = await captureFrameAtTimestamp(videoElem, bookmark.time);

					capturedAtLeastOneFrame = true;

					newCurrentVideoBookmarksWithFrames.push({
						...bookmark,
						dataUrl,
					});
				} catch (error) {
					console.error(error);

					// Still return the bookmark (without a frame) so that it shows up in the popup.
					newCurrentVideoBookmarksWithFrames.push(bookmark);
				}
			}

			cachedBookmarksWithFrames = {
				videoId: currentVideoId,
				bookmarksWithFrames: newCurrentVideoBookmarksWithFrames,
			};

			if (capturedAtLeastOneFrame) {
				// Because capturing a frame requires that we go to the actual time in the video, reset the time back to the timestamp that the user was on before starting to capture the bookmarked frames.
				videoElem.currentTime = timestampBeforeCapturing;
			}

			bookmarkButtons.forEach((bookmarkButton) => {
				bookmarkButton.disabled = false;
			});

			return newCurrentVideoBookmarksWithFrames;
		case 'content-get-current-video-time-and-duration':
			if (!videoElem) {
				videoElem = await getAndWaitForVideoToExist();
			}

			const { currentTime, duration } = videoElem;

			return {
				currentTime,
				duration,
			};
		case 'update-user-settings':
			await fetchUserSettings();
			break;
	}
});

/**
 * @description Fetch the "userSettings" property from Chrome's Storage.
 */
const fetchUserSettings = async () => {
	const obj = await chrome.storage.sync.get('userSettings');
	const chromeStorageUserSettingsJsonObj = obj && obj['userSettings'] ? JSON.parse(obj['userSettings']) : {};
	// Use the default value for any setting that hasn't been set yet.
	userSettings = { ...DEFAULT_USER_SETTINGS, ...chromeStorageUserSettingsJsonObj };
};

/**
 * @description Resets all the global variables to their default values. Useful for when we land on a new video page.
 */
const resetGlobalVariables = () => {
	youtubeRightControls = null;
	videoElem = null;
	currentVideoId = '';
	currentVideoType = '';
	currentVideoBookmarks = [];
	currentVideoFullObj = null;
	userSettings = null;
};

const getCurrentVideoId = async () => {
	const currentUrl = window.location.href;
	const isYouTubeFullVideo = currentUrl && currentUrl.includes('youtube.com/watch');
	const isYouTubeShortsVideo = currentUrl && currentUrl.includes('youtube.com/shorts');
	const isYouTubeVideo = isYouTubeFullVideo || isYouTubeShortsVideo;

	if (isYouTubeVideo) {
		const queryParameters = currentUrl.split('?')[1];
		const urlParameters = new URLSearchParams(queryParameters);
		const videoId = isYouTubeFullVideo ? urlParameters.get('v') : getYouTubeShortsVideoId(currentUrl);

		currentVideoId = videoId;
		currentVideoType = isYouTubeFullVideo ? 'watch' : 'shorts';
	} else {
		currentVideoId = '';
		currentVideoType = '';
	}
};

/**
 * @description Waits for a video element with the class "video-stream" to exist in the DOM.
 * @returns {Promise<HTMLVideoElement>} Resolves with the video element once it exists, or rejects after 5 seconds if not found.
 */
const getAndWaitForVideoToExist = async () => {
	// There can be more than one "video-stream" element on the page (for example, with YouTube Shorts). Use the one that has a video loaded ("src") over the empty ones.
	const getVideoStreamElem = () => {
		const videoStreamElemList = Array.from(document.querySelectorAll('video.video-stream'));
		return videoStreamElemList.find((videoStreamElem) => videoStreamElem.src) || videoStreamElemList[0];
	};

	return new Promise((resolve, reject) => {
		const timeout = 5000; // Timeout after 5 seconds
		const checkInterval = 100; // Check every 100ms

		// Check if the video element already exists
		const videoElem = getVideoStreamElem();
		if (videoElem) {
			resolve(videoElem); // Resolve immediately if it exists
			return;
		}

		// Set up a timeout to reject the promise after 5 seconds
		const timeoutId = setTimeout(() => {
			clearInterval(intervalId); // Stop the interval if the timeout occurs
			reject(new Error('Video element not found within 5 seconds.'));
		}, timeout);

		// Set up an interval to check for the video element
		const intervalId = setInterval(() => {
			const videoElem = getVideoStreamElem();
			if (videoElem) {
				clearInterval(intervalId); // Stop checking once the video element is found
				clearTimeout(timeoutId); // Clear the timeout to prevent rejection
				resolve(videoElem); // Resolve with the video element
			}
		}, checkInterval);
	});
};

/**
 * @description Checks if a video element exists and is ready for playback. Resolves when the video is ready.
 * @param {HTMLVideoElement} videoElement - The video element to check.
 * @returns {Promise} - A promise that resolves when the video is ready for playback.
 */
const waitForVideoToBeReady = (videoElement) => {
	return new Promise((resolve, reject) => {
		if (!videoElement) {
			reject('Video element not provided');
			return;
		}

		// If the video is already ready, resolve immediately
		if (videoElement.readyState >= 2) {
			resolve();
			return;
		}

		// Listen for the "loadeddata" event as a backup trigger for readiness
		videoElement.addEventListener(
			'loadeddata',
			() => {
				if (videoElement.readyState >= 2) {
					resolve();
				}
			},
			{ once: true }
		);

		// Never wait forever. If the video still isn't ready after 5 seconds, continue anyway. Any frames that can't be captured will just not be shown.
		setTimeout(resolve, 5000);
	});
};

/**
 * @description Monitor the video element on the page for any changes to its current time to visually change the progress bar and timestamp on the page to be for the "part" of the video that we are on.
 */
const monitorVideoElement = async () => {
	await fetchBookmarks();
	await fetchUserSettings();

	// Nothing to monitor if we're not on a video page (such as the YouTube home page).
	if (!currentVideoId) {
		return;
	}

	if (!videoElem) {
		videoElem = await getAndWaitForVideoToExist();
	}

	// Remove the previous "timeupdate" listener (from a previous video) so that it's only ever added once.
	if (handleTimeUpdate) {
		document.querySelectorAll('video').forEach((elem) => elem.removeEventListener('timeupdate', handleTimeUpdate));
	}

	handleTimeUpdate = () => {
		if (videoElem) {
			editVideoProgressBarAndTimeVisually(videoElem.duration);
		}
	};

	handleTimeUpdate();

	// Add an event listener for the 'timeupdate' event
	videoElem.addEventListener('timeupdate', handleTimeUpdate);
};

/**
 * @description Gets the font size of the "Part X/X" text. It's bigger when the video is in fullscreen mode.
 * @returns {String}
 */
const getPartElemFontSize = () => (document.fullscreenElement ? '20px' : '13px');

// When the video goes in or out of fullscreen mode, change the font size of the "Part X/X" text.
document.addEventListener('fullscreenchange', () => {
	const partElem = document.querySelector('.left-controls-part-elem');

	if (partElem) {
		partElem.style.fontSize = getPartElemFontSize();
	}
});

/**
 * @description Edit the progress bar and timestamp of the main video on the page by adding and editing DOM elements to the page to simulate the video being broken up into smaller parts.
 */
const editVideoProgressBarAndTimeVisually = async (videoDuration) => {
	if (!userSettings) {
		await fetchUserSettings();
	}

	// Only full videos have a progress bar and timestamp to edit (Shorts don't).
	if (currentVideoType !== 'watch') {
		return;
	}

	const hasBookmarks = currentVideoBookmarks && currentVideoBookmarks.length > 0;

	// Only edit the main video player ("#movie_player"). Other players (like a Shorts player from a previous page) can still be in the DOM.
	const playerElem = document.querySelector('#movie_player');

	if (!playerElem) {
		return;
	}

	const lastBookmarkTime =
		currentVideoBookmarks &&
		currentVideoBookmarks[currentVideoBookmarks.length - 1] &&
		currentVideoBookmarks[currentVideoBookmarks.length - 1].time;

	// When there are no bookmarks or we have gone through all of them, then clean up the timestamp elements and return them back to normal (this also undoes edits left over from the previous video).
	if (!hasBookmarks || !userSettings.splitVideoIntoParts || lastBookmarkTime <= videoElem.currentTime) {
		// Nothing to undo, or the new video's duration isn't known yet (right after navigating).
		if (timestampTextBackToNormal || !Number.isFinite(videoDuration)) {
			return;
		}

		// Edit the content
		playerElem.querySelector('.ytp-time-current').textContent = formatTime(Math.floor(videoElem.currentTime));
		playerElem.querySelector('.ytp-time-duration').textContent = formatTime(Math.floor(videoDuration));

		const partElem = document.querySelector('.left-controls-part-elem');

		if (partElem) {
			partElem.parentElement.removeChild(partElem);
		}

		timestampTextBackToNormal = true;

		return;
	}

	timestampTextBackToNormal = false;

	const { currentTime, endTime, currentBookmarkIndex } =
		currentVideoBookmarks && getCurrentBookmarkInfoBasedOnTime(videoElem.currentTime);

	playerElem.querySelector('.ytp-time-current').textContent = formatTime(Math.floor(currentTime));
	playerElem.querySelector('.ytp-time-duration').textContent = formatTime(Math.floor(endTime));

	const progressBarWidth = playerElem.querySelector('.ytp-progress-bar-container').getBoundingClientRect().width;
	const progressNum = currentTime / endTime;

	const currentTimeCircleThumb = playerElem.querySelector('.ytp-scrubber-container');
	currentTimeCircleThumb.style.transform = `translateX(${progressBarWidth * progressNum}px)`;

	const playProgressElem = playerElem.querySelector('.ytp-play-progress');
	playProgressElem.style.transform = `scaleX(${progressNum})`;

	addCurrentBookmarkInfoToLeftControls(currentBookmarkIndex);
};

/**
 * @description Add the current part info to the YouTube video player's left controls. This will add a piece of text saying "Part X/X". When that's clicked, it will open the popup and automatically scroll to the part (assuming the automatic scroll is turned on).
 * @param {Number} currentBookmarkIndex
 */
const addCurrentBookmarkInfoToLeftControls = (currentBookmarkIndex) => {
	const totalBookmarksNum = currentVideoBookmarks.length;

	let partElem = document.querySelector('.left-controls-part-elem');

	if (!partElem) {
		partElem = document.createElement('div');
		partElem.className = 'left-controls-part-elem';
		partElem.style.fontSize = getPartElemFontSize();
		partElem.addEventListener('click', async () => {
			await chrome.runtime.sendMessage({ type: 'open-popup' });
		});
	}

	partElem.innerHTML = `• Part ${currentBookmarkIndex + 1}/${totalBookmarksNum} ${getIconSVG('chevron-right', 'white', '10px', '10px')}`;

	const ytpLeftControlsElem = document.querySelector('#movie_player .ytp-left-controls');
	ytpLeftControlsElem.appendChild(partElem);
};

/**
 * @description Go through all of the bookmarks and find the first bookmark that has a time greater than the video's current time. This is the "current" bookmark. Then, for this bookmark get it's "current" and "end" time based on a couple of different factors like the video's current time, the previous bookmark, etc.
 * @param {Number} videoCurrentTime
 * @returns {Object}
 */
const getCurrentBookmarkInfoBasedOnTime = (videoCurrentTime) => {
	for (let i = 0; i < currentVideoBookmarks.length; i++) {
		const bookmark = currentVideoBookmarks[i];

		if (bookmark.time > videoCurrentTime) {
			return getBookmarkCurrentAndEndTime(currentVideoBookmarks, videoCurrentTime, bookmark, i);
		}
	}
};

/**
 * @description Set everything up for the current page: add the bookmark button and start editing the progress bar and time for the "parts" of the video.
 */
const setUpCurrentPage = () => {
	// Reset the global variables each time we land on a new page to prevent the previous video's state from leaking into the new one.
	resetGlobalVariables();

	// Remove the "Part X/X" text from the previous video (if any).
	const partElem = document.querySelector('.left-controls-part-elem');

	if (partElem) {
		partElem.parentElement.removeChild(partElem);
	}

	addBookmarkButtonToVideo();
	monitorVideoElement().catch(console.error);
};

// When bookmarks are edited or deleted in the popup, get the latest ones so that the "Part X/X" text stays up to date.
chrome.storage.onChanged.addListener(() => fetchBookmarks());

// YouTube is a single page app so going to a new video doesn't reload the page. Instead, YouTube fires this event every time it finishes navigating to a new page (including scrolling to a new Short).
window.addEventListener('yt-navigate-finish', setUpCurrentPage);

setUpCurrentPage();
