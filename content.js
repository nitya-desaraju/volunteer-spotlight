// This script is injected into the webpage and has access to the page's DOM and user session.

// Guard to prevent multiple scrapes from running simultaneously
let scrapeInProgress = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startScrape") {
        if (scrapeInProgress) {
            console.log("Scrape already in progress. Ignoring new request.");
            sendResponse({ status: "already running" });
            return true;
        }

        scrapeInProgress = true;
        console.log("Content script received startScrape message. Starting full scrape...");
        sendResponse({ status: "received" });

        const scrapeAndProcess = async () => {
            try {
                // --- CUSTOMIZE THIS SECTION (PART 1: Main Calendar Page) ---
                const dayContainerSelector = 'table#SignupFromCalendarTable td';
                const directEventSelector = 'ul li a'; 
                const seeAllEventsSelector = 'div.moreShifts a';
                // --- END CUSTOMIZATION ---

                let dayContainers = Array.from(document.querySelectorAll(dayContainerSelector));
                if (dayContainers.length === 0) {
                     chrome.runtime.sendMessage({ action: "scrapingError", data: { error: "No day containers found. Check 'dayContainerSelector' in content.js." } });
                    return;
                }
                
                dayContainers = dayContainers.filter(td => td.querySelector('a'));
                dayContainers = dayContainers.slice(0, 7);

                let finalEventUrls = new Set();
                let seeAllPagesToFetch = [];
                
                dayContainers.forEach(container => {
                    const seeAllLink = container.querySelector(seeAllEventsSelector);
                    if (seeAllLink) {
                        seeAllPagesToFetch.push(new URL(seeAllLink.href, window.location.origin).href);
                    } else {
                        const directLinks = container.querySelectorAll(directEventSelector);
                        directLinks.forEach(el => {
                            finalEventUrls.add(new URL(el.href, window.location.origin).href);
                        });
                    }
                });

                chrome.runtime.sendMessage({ action: "updateStatus", data: `Found ${finalEventUrls.size} direct events and ${seeAllPagesToFetch.length} 'See All' pages...` });

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
                            const eventLinkOnDayPageSelector = '.activityShiftLink';
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

                chrome.runtime.sendMessage({ action: "updateStatus", data: `Found a total of ${uniqueEventUrls.length} unique events. Fetching details sequentially...` });

                const detailedEvents = [];
                const delay = ms => new Promise(res => setTimeout(res, ms));

                for (const url of uniqueEventUrls) {
                    try {
                        const randomDelay = Math.floor(Math.random() * (15 - 5 + 1)) + 5;
                        await delay(randomDelay);
                        
                        chrome.runtime.sendMessage({ action: "updateStatus", data: `Fetching event ${detailedEvents.length + 1} of ${uniqueEventUrls.length}...` });

                        const response = await fetch(url, {
                                method: 'GET', 
                                headers: {
                                    'Accept': 'text/html, */*; q=0.01',
                                    'X-Requested-With': 'XMLHttpRequest'
                                }
                            });

                        if (!response.ok) {
                            detailedEvents.push({ url, title: 'Fetch Error', isVolunteerDependent: false, animalSpecificity: null });
                            continue;
                        }

                        const htmlText = await response.text();
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(htmlText, 'text/html');

                        // --- CUSTOMIZE THIS SECTION (PART 3: Final Detail Page) ---
                        const titleSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h2';
                        const detailTitleSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h2:nth-child(2)';
                        const dateSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h3';
                        const divSelector = 'div#SignupFromCalendarSignupToShiftDialogContent';
                        // --- END CUSTOMIZATION ---

                        const titleNode = doc.querySelector(titleSelector);
                        let title = '';
                        if (titleNode) {
                            titleNode.childNodes.forEach(node => {
                            if (node.nodeType === 3) {
                                title += node.textContent;
                            }
                            });
                        }
                        title = title.trim() || 'No Title Found';

                        const detail = doc.querySelector(detailTitleSelector)?.innerText.trim() || 'No Detail Found';
                        const dateInput = doc.querySelector(dateSelector)?.innerText.trim() || 'N/A';
                        
                        const dateRegex = /^(.+?)\s+(\d{1,2}:\d{2}.*)$/;
                        const dateMatches = dateInput.match(dateRegex);
                        let dateString = "", timeString = "";

                        if (dateMatches && dateMatches.length > 2) {
                            dateString = dateMatches[1].trim();
                            timeString = dateMatches[2].trim();
                        }

                        const inputText = doc.querySelector(divSelector)?.innerText.trim() || 'N/A';
                        const openingsRegex = /(\d+)\s+of\s+(\d+)/;
                        const openingsMatches = inputText.match(openingsRegex);
                        let openingsAvailable, totalOpenings;

                        if (openingsMatches) {
                            openingsAvailable = parseInt(openingsMatches[1], 10);
                            totalOpenings = parseInt(openingsMatches[2], 10);
                        }

                        let pawNumber = null;
                        let animalSpecificity = null;
                        const pawRegex = /(\d+)\s*paw/i;
                        const pawMatch = inputText.match(pawRegex);
                        if (pawMatch) {
                            pawNumber = parseInt(pawMatch[1], 10);
                            // If paw level is 3 or higher, check for animal type on the same line
                            if (pawNumber >= 3) {
                                const pawLine = inputText.split('\n').find(line => line.match(pawRegex));
                                if (pawLine) {
                                    const hasDog = /dog/i.test(pawLine);
                                    const hasCat = /cat/i.test(pawLine);
                                    if (hasDog && !hasCat) animalSpecificity = "Dog";
                                    else if (hasCat && !hasDog) animalSpecificity = "Cat";
                                }
                            }
                        }
                        
                        const isVolunteerDependent = inputText.includes("Volunteer-Dependent Activity!");
                        const activityLink = doc.querySelector('div#SignupFromCalendarSignupToShiftDialogContent a#GoToActivityPageLink')?.href || 'N/A';
                        
                        detailedEvents.push({ activityLink, title, detail, dateString, timeString, openingsAvailable, totalOpenings, pawNumber, isVolunteerDependent, animalSpecificity });

                    } catch (error) {
                        console.error(`Error processing detail page ${url}:`, error);
                        detailedEvents.push({ url, title: 'Processing Error', isVolunteerDependent: false, animalSpecificity: null });
                    }
                }

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
                scrapeInProgress = false;
            }
        };

        scrapeAndProcess();
        return true;
    }
});