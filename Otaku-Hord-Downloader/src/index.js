const fs = require('fs');
const { promisify } = require('util');
const path = require('path');
const axios = require('axios');
const readline = require('readline');
const ffmpeg = require('fluent-ffmpeg');
const probe = promisify(ffmpeg.ffprobe);
const { exec } = require('child_process');
const ProgressBar = require('progress'); // Import progress

const search = require('./services/search');
const animeInfo = require('./services/animeInfo');

const providerInit = require('./processEpisode/providerInit');
const decryptAllAnime = require('./processEpisode/decryptAllAnime');
const getLinks = require('./processEpisode/getLinks');
const m3u8Extractor = require('./extractors/m3u8');

const aniurl = 'https://allanime.to';
const aniapi = 'https://api.allanime.day/api';

let rl;
const downloadFolder = 'E:/Anime'; // Set the download location to D:/Anime

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const Userproviders = [1, 2, 3, 4, 5];
const quality = 'best';

let totalDownloaded = 0; // Track the total downloaded size in MB
let completedEpisodes = 0; // Track the number of episodes completed
let totalEpisodes = 0; // Total episodes to download

function askQuestion(question) {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer);
    });
  });
}

async function main() {
  while (true) { // Loop until user decides to stop
    try {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

      const searchKeyword = await askQuestion('Enter the search keyword: ');
      const translationType = 'dub';
      const searchResponse = await search(searchKeyword, translationType);

      if (!searchResponse.data.data.shows.edges.length) {
        console.log("No results found");
        rl.close();
        continue; // Restart if no results found
      }

      let AnimeNumber = 0;
      const shows = searchResponse.data.data.shows.edges;

      if (shows.length === 1) {
        console.log("Found result for:", shows[0].englishName);
      } else {
        shows.slice(0, 10).forEach((show, i) => {
          console.log(`${i + 1}. ${show.englishName} - Episodes: ${show.episodeCount || 'Unknown'}`);
          console.log(`   https://allmanga.to/bangumi/${show._id}`);
        });

        AnimeNumber = await askQuestion('Multiple results found, enter the number: ') - 1;
      }

      console.log("Episodes:", translationType === 'sub' ? shows[AnimeNumber].availableEpisodes.sub : shows[AnimeNumber].availableEpisodes.dub);

      const episodesInput = await askQuestion('Enter the episode number or range (e.g.: 4-6): ');
      rl.close(); // Close readline after episode input

      const showId = shows[AnimeNumber]._id;
      const episodeArray = processEpisodeRange(episodesInput);
      totalEpisodes = episodeArray.length; // Set the total episodes count for progress tracking
      await processEpisode(showId, episodeArray, translationType, AnimeNumber, shows);

      // Ask the user again if they want to download more
      const anotherAnime = await askQuestion('Do you want to download another anime? (yes/no): ');
      rl.close(); // Close readline after "Do you want to download another anime?"
      if (anotherAnime.toLowerCase() !== 'yes') {
        break; // Exit the loop if the user doesn't want to continue
      }

    } catch (error) {
      console.error("Error:", error);
    }
  }

  console.log("Goodbye!");
}

function processEpisodeRange(episodes) {
  if (episodes.includes('-')) {
    const [start, end] = episodes.split('-').map(Number);
    return Array.from({ length: end - start + 1 }, (_, i) => (start + i).toString());
  }
  return [episodes];
}

async function processEpisode(showId, episodeArray, translationType, AnimeNumber, shows) {
  const globalProgressBar = new ProgressBar('Downloading: :percent [:bar] :speed Total Downloaded: :total_downloaded MB', {
    total: totalEpisodes,
    width: 50,
    complete: '▓',
    incomplete: '▒',
    renderThrottle: 500 // Update the progress bar every 500ms
  });

  const downloadPromises = episodeArray.map(async (currentEpisode) => {
    const queryVariables = { showId, translationType, episodeString: currentEpisode };
    const extensions = { persistedQuery: { version: 1, sha256Hash: '5f1a64b73793cc2234a389cf3a8f93ad82de7043017dd551f38f65b89daa65e0' } };

    try {
      const response = await animeInfo(queryVariables, extensions);
      const data = response.data;
      const resp = data?.data?.episode?.sourceUrls?.map(url => `${url.sourceName} : ${url.sourceUrl}`).join('\n');

      if (!resp) {
        console.log(`No results found for episode: ${currentEpisode}`);
        return; // Skip if no result found
      }

      const resolvedLinkLists = (await Promise.all(Userproviders.map(provider => generateLink(provider, resp)))).filter(link => link !== undefined);
      const qualityLink = selectQuality(resolvedLinkLists, quality);

      if (!qualityLink) {
        console.log(`No valid links found for episode: ${currentEpisode}`);
        return; // Skip if no valid link found
      }

      await downloadFile(qualityLink, shows[AnimeNumber].englishName, currentEpisode, globalProgressBar);
      
    } catch (error) {
      console.error("Error occurred for episode", currentEpisode, ":", error);
    }
  });

  // Use Promise.all to run all downloads concurrently
  await Promise.all(downloadPromises);
}

async function generateLink(provider, resp) {
  let providerId;
  switch (provider) {
    case 1: providerId = providerInit("Default", resp); break;
    case 2: providerId = providerInit("Sak", resp); break;
    case 3: providerId = providerInit("Kir", resp); break;
    case 4: providerId = providerInit("S-mp4", resp); break;
    default: providerId = providerInit("Luf-mp4", resp); break;
  }

  if (!providerId) return;
  
  providerId = decryptAllAnime(providerId).replace(/\/clock/g, '/clock.json');
  
  try {
    return await getLinks(providerId);
  } catch (error) {
    console.error('Error fetching links:', error);
  }
}

function selectQuality(links, quality) {
  if (!links.length) return null;
  
  const bestQuality = links.find(link => link.includes(quality)) || links[0];
  console.log(`Selected quality: ${bestQuality}`);
  return bestQuality;
}

async function downloadFile(fileUrl, animeName, episodeNumber, globalProgressBar) {
  if (!fileUrl.startsWith('http')) {
    console.error('Invalid URL:', fileUrl);
    return;
  }

  const downloadsFolder = path.join(downloadFolder, sanitizeFolderName(animeName)); // Use the global downloadFolder variable
  if (!fs.existsSync(downloadsFolder)) fs.mkdirSync(downloadsFolder, { recursive: true });

  const filePath = path.join(downloadsFolder, `${sanitizeFolderName(animeName)}_EP${episodeNumber}.mp4`);

  // Fetch the file size before starting the download (if possible)
  const headResponse = await axios.head(fileUrl);
  const totalFileSize = parseInt(headResponse.headers['content-length'], 10); // Size in bytes
  totalDownloaded += totalFileSize;

  let episodeDownloaded = 0; // Track download progress for each episode
  let downloadSpeed = ''; // Track download speed

  console.log(`Starting download for EP${episodeNumber} using aria2c...`);

  return new Promise((resolve, reject) => {
    const downloadProcess = exec(`aria2c -x 16 -s 16 -j 12 -d "${downloadsFolder}" -o "${path.basename(filePath)}" "${fileUrl}"`, (error, stdout, stderr) => {
      if (error) {
        console.error('aria2c error:', stderr);
        reject(error);
      } else {
        console.log(`Download completed: ${filePath}`);
        completedEpisodes++;
        globalProgressBar.update(completedEpisodes / totalEpisodes); // Update progress bar when episode is done
        resolve(filePath);
      }
    });

    // Monitor aria2c output for download progress
    downloadProcess.stdout.on('data', (data) => {
      const dataStr = data.toString();

      // Capture the download speed (KB/s, MB/s, GB/s)
      const speedMatch = dataStr.match(/(\d+\.?\d*)\s?(KB\/s|MB\/s|GB\/s)/);

      // Capture the total downloaded size (in MB)
      const totalMatch = dataStr.match(/(\d+\.?\d*)\s?MB/);

      if (speedMatch) {
        downloadSpeed = speedMatch[0];
      }

      if (totalMatch) {
        episodeDownloaded = parseFloat(totalMatch[1]);
        totalDownloaded += episodeDownloaded;

        // Update the global progress bar based on total downloaded size
        globalProgressBar.update(completedEpisodes / totalEpisodes, {
          speed: downloadSpeed,
          total_downloaded: (totalDownloaded / 1024).toFixed(2) // Convert to MB
        });
      }
    });

    downloadProcess.stderr.on('data', (data) => {
      console.error('Error:', data.toString());
    });
  });
}

function sanitizeFolderName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_');
}

main();
