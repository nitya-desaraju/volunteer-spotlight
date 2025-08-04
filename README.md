# Volunteer Shift Spotlight

A Google Chrome extension that scrapes shift data off of the volunteer calendar and exports it to a Google Sheet. A website then displays the data. It can be viewed [here](https://nitya-desaraju.github.io/spotlight/).

## Introduction

I've volunteered for my local animal shelter, Operation Kindness, for over a year. I love animals and helping those who need it, so I wanted to do something more. I approached the manager at the shelter to see if there was a problem I could help solve with technology. We brainstormed a few ideas and we went with this one. She told me she needed a way to find and highlight shifts that were in urgent need of volunteers without manually clicking on each shift everyday and mass email volunteers. There could be almost 200 shifts in a week, so this was quite a tedious and error-prone manual process.

## How this works

The Chrome extension reads the html off of the calendar and, using a Google Spreadsheets API, writes the data to a spreadsheet. The website displays urgent shifts based on certain criteria for the data.

## Features

- Puts shifts marked as "Volunteer-Dependent" in the urgent section if they are 50% full or less
- All upcoming shifts in the next week under the categories chosen in the extension's filters by the shelter manager
- Filters are saved from the previous time so they don't have to be reentered
- Information icons to explain what each section contains in the website
- Direct links to shift signup on the website
- Link to shelter website in the top banner

## Challenges

The volunteer website did not have an API, which is why I had to use an extension to read the html. This was very difficult project for me because I was working with languages I wasn't extremely familiar with. This was also my first time making an extension. I spent a lot of time searching up syntax, learning how to use it, and consulting my dad. I learned a lot about scraping html off of a page, debugging through a browser console, and JavaScript/HTML.

#### Additional Note

I only have a few hours recorded on hackatime because I started this project before I joined Athena. In total, I spent about 40 hours.

#### AI Usage

My code is about 10-20% AI. I used it to help me debug and fill in some knowledge gaps in niche areas that weren't easy to search up.