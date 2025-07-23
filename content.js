// This script is injected into the webpage and has access to the page's DOM and user session.

// Guard to prevent multiple scrapes from running simultaneously
let scrapeInProgress = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startScrape") {
        // If a scrape is already running, do nothing.
        if (scrapeInProgress) {
            console.log("Scrape already in progress. Ignoring new request.");
            sendResponse({ status: "already running" });
            return true;
        }

        scrapeInProgress = true;
        console.log("Content script received startScrape message. Starting full scrape...");
        sendResponse({ status: "received" }); // Acknowledge the message

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
                
                dayContainers = [dayContainers[3], dayContainers[4]];
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
                            const response = await fetch(dayPageUrl, {
                                method: 'POST', 
                                headers: {
                                    'Content_Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                    'Accept': 'text/html, */*; q=0.01',
                                    'X-Requested-With': 'XMLHttpRequest'
                                }
                            });
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

                //uniqueEventUrls = [uniqueEventUrls[0]];
                if (uniqueEventUrls.length === 0) {
                    chrome.runtime.sendMessage({ action: "scrapingError", data: { error: "No events found after full scan. Check all CSS selectors in content.js." } });
                    return;
                }

                chrome.runtime.sendMessage({ action: "updateStatus", data: `Found a total of ${uniqueEventUrls.length} unique events. Fetching details sequentially...` });

                // Step 3: Fetch details for every unique event URL sequentially with a random delay.
                const detailedEvents = [];
                const delay = ms => new Promise(res => setTimeout(res, ms)); // Helper delay function

                for (const url of uniqueEventUrls) {
                    try {
                        // Add a random delay between 5ms and 15ms to be less aggressive
                        const randomDelay = Math.floor(Math.random() * (15 - 5 + 1)) + 5;
                        await delay(randomDelay);
                        
                        // Provide progress updates to the popup
                        chrome.runtime.sendMessage({ action: "updateStatus", data: `Fetching event ${detailedEvents.length + 1} of ${uniqueEventUrls.length}...` });

                        const response = await fetch(url, {
                                method: 'GET', 
                                headers: {
                                    'Accept': 'text/html, */*; q=0.01',
                                    'X-Requested-With': 'XMLHttpRequest'
                                }
                            });

                        if (!response.ok) {
                            console.error(`Fetch Error for ${url}: Status ${response.status}`);
                            detailedEvents.push({ url, title: 'Fetch Error', date: 'N/A', time: 'N/A', location: 'N/A', description: 'N/A' });
                            continue; // Move to the next URL
                        }

                        const htmlText = await response.text();
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(htmlText, 'text/html');

                        // --- CUSTOMIZE THIS SECTION (PART 3: Final Detail Page) ---
                        const titleSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h2'; // Example selector
                        const detailTitleSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h2:nth-child(2)'; // Example selector
                        const dateSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h3';
                        const divSelector = 'div#SignupFromCalendarSignupToShiftDialogContent';
                        
                        // const timeSelector = '.event-time-class';
                        // const locationSelector = '.event-location-class';
                        // const descriptionSelector = '.event-description-class';
                        // --- END CUSTOMIZATION ---

                        const titleNode = doc.querySelector(titleSelector); // ?.innerText.trim() || 'No Title Found';
                        let title = '';

                        // Loop through all the direct children of the h2
                        if (titleNode) {
                            titleNode.childNodes.forEach(node => {
                            // Find the text nodes (nodeType === 3)
                            if (node.nodeType === 3) {
                                // Add the text content of the node to our result
                                title += node.textContent;
                            }
                            });
                        }
                        
                        // Use .trim() to remove all the extra whitespace from the beginning and end
                        title = title.trim() || 'No Title Found';

                        const detail = doc.querySelector(detailTitleSelector)?.innerText.trim() || 'No Detail Found';
                        const dateInput = doc.querySelector(dateSelector)?.innerText.trim() || 'N/A';
                        
                        const dateRegex = /^(.+?)\s+(\d{1,2}:\d{2}.*)$/;
                        const dateMatches = dateInput.match(dateRegex);
                        let dateString = "";
                        let timeString = "";

                        if (dateMatches && dateMatches.length > 2) {
                            dateString = dateMatches[1].trim();
                            timeString = dateMatches[2].trim();
                        } else {
                            console.log(`Could not parse date/time string: "${dateInput}"`);
                        }

                        const inputText = doc.querySelector(divSelector)?.innerText.trim() || 'N/A';
                        const openingsRegex = /(\d+)\s+of\s+(\d+)/;
                        const openingsMatches = inputText.match(openingsRegex);
                        let openingsAvailable;
                        let totalOpenings;

                        if (openingsMatches) {
                            openingsAvailable = parseInt(openingsMatches[1], 10);
                            totalOpenings = parseInt(openingsMatches[2], 10);
                        } else {
                            console.log("Openings pattern not found in the string.");
                        }

                        let pawNumber = null;
                        const pawRegex = /(\d+)\s*paw/i;
                        const pawMatch = inputText.match(pawRegex);
                        if (pawMatch) {
                            pawNumber = parseInt(pawMatch[1], 10);
                        }
                        
                        const activityLink = doc.querySelector('div#SignupFromCalendarSignupToShiftDialogContent a#GoToActivityPageLink')?.href || 'N/A';
                        
                        detailedEvents.push({ activityLink, title, detail, dateString, timeString, openingsAvailable, totalOpenings, pawNumber});

                    } catch (error) {
                        console.error(`Error processing detail page ${url}:`, error);
                        detailedEvents.push({ url, title: 'Processing Error', date: 'N/A', time: 'N/A', location: 'N/A', description: 'N/A' });
                    }
                }

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
            } finally {
                // Reset the guard so a new scrape can be started next time.
                scrapeInProgress = false;
            }
        };

        scrapeAndProcess();
        return true; // Indicate async response.
    }
});