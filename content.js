// This script is injected into the webpage and has access to the page's DOM and user session.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startScrape") {
        console.log("Content script received startScrape message. Starting full scrape with optimized multi-level logic...");

        const scrapeAndProcess = async () => {
            try {
                // --- CUSTOMIZE THIS SECTION (PART 1: Main Calendar Page) ---
                // NEW: Selector for the container of each day's events. This is crucial for the new logic.
                const dayContainerSelector = 'table#SignupFromCalendarTable td'; // Example selector for a day cell
                // Selector for direct event links within a day container.
                const directEventSelector = 'ul li a'; 
                // Selector for "See all events" or "+X more" links within a day container.
                const seeAllEventsSelector = 'div.moreShifts a'; // Example selector
                // --- END CUSTOMIZATION ---

                var dayContainers = document.querySelectorAll(dayContainerSelector);
                if (dayContainers.length === 0) {
                     chrome.runtime.sendMessage({ action: "scrapingError", data: { error: "No day containers found. Check 'dayContainerSelector' in content.js." } });
                    return;
                }

                // Use a Set to automatically handle duplicate URLs.
                let finalEventUrls = new Set();
                let seeAllPagesToFetch = [];
                
                dayContainers = [dayContainers[6]];
                // Step 1: Iterate through each day container to decide the scraping strategy.
                dayContainers.forEach(container => {
                    const seeAllLink = container.querySelector(seeAllEventsSelector);
                    if (seeAllLink) {
                        // If a "See All" link exists, we only need to process that page.
                        seeAllPagesToFetch.push(new URL(seeAllLink.href, window.location.origin).href);
                    } else {
                        // If no "See All" link, gather the direct event links from this day.
                        const directLinks = container.querySelectorAll(directEventSelector);
                        directLinks.forEach(el => {
                            finalEventUrls.add(new URL(el.href, window.location.origin).href);
                        });
                    }
                });

                chrome.runtime.sendMessage({ action: "updateStatus", data: `Found ${finalEventUrls.size} direct events and ${seeAllPagesToFetch.length} 'See All' pages...` });

                // Step 2: Fetch and parse the "See All Events" pages to find more event URLs.
                if (seeAllPagesToFetch.length > 0) {
                    const seeAllPromises = seeAllPagesToFetch.map(async (dayPageUrl) => {
                        try {
                            const response = await fetch(dayPageUrl);
                            if (!response.ok) return;

                            const htmlText = await response.text();
                            const parser = new DOMParser();
                            const dayPageDoc = parser.parseFromString(htmlText, 'text/html');

                            // --- CUSTOMIZE THIS SECTION (PART 2: "See All" Page) ---
                            // Selector for the individual event links on the "See All Events" page.
                            const eventLinkOnDayPageSelector = '.activityShiftLink'; // Example selector
                            // --- END CUSTOMIZATION ---

                            const linksOnDayPage = dayPageDoc.querySelectorAll(eventLinkOnDayPageSelector);
                            linksOnDayPage.forEach(eventLink => {
                                finalEventUrls.add(new URL(eventLink.href, window.location.origin).href);
                            });
                        } catch (error) {
                            console.error(`Failed to process 'See All' page ${dayPageUrl}:`, error);
                        }
                    });
                    await Promise.all(seeAllPromises);
                }

                const uniqueEventUrls = Array.from(finalEventUrls);
                if (uniqueEventUrls.length === 0) {
                    chrome.runtime.sendMessage({ action: "scrapingError", data: { error: "No events found after full scan. Check all CSS selectors in content.js." } });
                    return;
                }

                chrome.runtime.sendMessage({ action: "updateStatus", data: `Found a total of ${uniqueEventUrls.length} unique events. Fetching details...` });

                // Step 3: Fetch details for every unique event URL gathered from all sources.
                const detailPromises = uniqueEventUrls.map(async (url) => {
                    try {
                        const response = await fetch(url);
                        if (!response.ok) {
                            return { url, title: 'Fetch Error', date: 'N/A', time: 'N/A', location: 'N/A', description: 'N/A' };
                        }
                        const htmlText = await response.text();
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(htmlText, 'text/html');

                        // --- CUSTOMIZE THIS SECTION (PART 3: Final Detail Page) ---
                        const titleSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h2:first-child'; // Example selector
                        const detailTitleSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h2:nth-child(2)'; // Example selector
                        const dateSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h3:first-child';
                        // const timeSelector = '.event-time-class';
                        // const locationSelector = '.event-location-class';
                        // const descriptionSelector = '.event-description-class';
                        // --- END CUSTOMIZATION ---

                        const title = doc.querySelector(titleSelector)?.innerText.trim() || 'No Title Found';
                        const detail = doc.querySelector(detailTitleSelector)?.innerText.trim() || 'No Detail Found';
                        const date = doc.querySelector(dateSelector)?.innerText.trim() || 'N/A';
                        // const time = doc.querySelector(timeSelector)?.innerText.trim() || 'N/A';
                        // const location = doc.querySelector(locationSelector)?.innerText.trim() || 'N/A';
                        // const description = doc.querySelector(descriptionSelector)?.innerText.trim() || 'N/A';

                        // return { url, title, date, time, location, description };
                        return { url, title, detail, date };
                    } catch (error) {
                        console.error(`Error processing detail page ${url}:`, error);
                        return { url, title: 'Processing Error', date: 'N/A', time: 'N/A', location: 'N/A', description: 'N/A' };
                    }
                });

                const detailedEvents = await Promise.all(detailPromises);

                // Step 4: Send the final, complete data array to the background script.
                chrome.runtime.sendMessage({
                    action: "processEvents",
                    data: {
                        events: detailedEvents,
                        spreadsheetId: request.spreadsheetId
                    }
                });

            } catch (error) {
                console.error("Error in content script:", error);
                chrome.runtime.sendMessage({ action: "scrapingError", data: { error: `Content script error: ${error.message}` } });
            }
        };

        scrapeAndProcess();
        return true; // Indicate async response.
    }
});
