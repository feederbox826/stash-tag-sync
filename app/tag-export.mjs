import axios from "axios";
import fs from "fs/promises";
import { createReadStream } from "fs";
import * as https from "https";
import mime from 'mime/lite';
import cliProgress from "cli-progress";
import crypto from "crypto";
import rs from "route-serve";
import cron from "node-cron";
import 'dotenv/config';

const APIKEY = process.env.STASH_APIKEY;
const STASH_URL = process.env.STASH_URL;
const TAG_PATH = process.env.TAG_PATH || "./tags";
const CACHE_PATH = process.env.CACHE_PATH || "./cache";
const IMG_FILETYPES = ["jpg", "png", "webp", "svg"];
const VID_FILETYPES = ["mp4", "webm"];
const ETAG_FILE_PATH = `${CACHE_PATH}/etags.json`;
const CACHE_FILE = `${CACHE_PATH}/cache.json`;
const TAG_EXPORT_PATH = process.env.TAG_EXPORT_PATH || `${CACHE_PATH}/tags-export.json`;
const EXCLUDE_PREFIX = ["r:", "c:", ".", "stashdb", "Figure", "["]
const RECHECK_ETAG = process.env.RECHECK_ETAG || false;
const SKIP_CACHE = process.env.SKIP_CACHE || false;

// setup axios agent without TLS verification
const agent = axios.create({
  headers: {
    'ApiKey': APIKEY
  },
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
})

// get all performers
async function getAllTags(updateTime = 0) {
  const query = `query ($update_time: String!) {
    findTags(filter: { per_page: -1 }
    tag_filter: { updated_at: { modifier: GREATER_THAN,
    value: $update_time }}) {
        tags {
            name
            image_path
            id
            ignore_auto_tag
    }}}`;
  const response = await agent.post(
    STASH_URL,
    { query, variables: { update_time: updateTime } },
  ).catch(err => err.response);
  return response.data.data.findTags.tags;
}

const checksumFile = (path) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = createReadStream(path);
    stream.on('error', err => reject(err));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

async function downloadFile(url, etagMap, force = false) {
  const etag = etagMap.get(url);
  const response = await agent.get(url, {
    method: "GET",
    responseType: "arraybuffer",
    responseEncoding: "binary",
    headers: {
      "If-None-Match": force ? "" : etag 
    }
  }).catch(err => err.response);
  const etagHeader = response.headers["etag"];
  if (etagHeader) etagMap.set(url, etagHeader);
  return response
}

// win-1252 conversion from https://stackoverflow.com/a/73127563
const cleanFileName = (filename) =>
  filename
    .trim()
    .replace(/\./g, "")
    .replace(/\:/g, "-")
    .replace(/ |\/|\\/g, "_")
    .replace(/%u(....)/g, (m,p)=>String.fromCharCode("0x"+p))
    .replace(/%(..)/g, (m,p)=>String.fromCharCode("0x"+p))

const saniTagExports = (tagExports) => {
  // remove trailing `./` and reduce to basename
  const saniFilename = (filename) => filename ? filename.split("/").pop() : "";
  for (const [key, value] of Object.entries(tagExports)) {
    tagExports[key]["img"] = saniFilename(value["img"]);
    tagExports[key]["vid"] = saniFilename(value["vid"]);
  }
  return tagExports;
}

const getAllFiles = async() => {
  const allFiles = await fs.readdir(TAG_PATH, { withFileTypes: true });
  const allFileNames = allFiles
  .filter(f => !f.isDirectory())
  .map(f => {
    const filename = f.name.split("/").pop();
    const ext = filename.split(".").pop();
    return `${cleanFileName(filename.split(".")[0])}.${ext}`;
  });
  return new Set(allFileNames);
}

const findFiles = async(tagName, searcharr) => {
  const files = [];
  for (const ext of searcharr) {
    const filename = `${TAG_PATH}/${tagName}.${ext}`;
    const isFile = await fs.access(filename)
      .then(() => true)
      .catch(() => false)
    if (isFile) files.push(filename);
  }
  return files;
}

const getAltFiles = async(dir) =>
  fs.readdir(dir)
    .then(files => files
      .map(f => f.split(".")[0].replace(/ \(\d\)/, ""))
    ).catch(() => []);

const parseFile = (filepath) =>
  fs.access(filepath)
    .then(async () => JSON.parse(await fs.readFile(filepath)))
    .catch(() => {});

// main function
async function main() {
  console.log("Starting tag sync");
  const multibar = new cliProgress.MultiBar({
    format: " {bar} {percentage}% | {value}/{total} | {name} {last}"
  }, cliProgress.Presets.shades_classic);
  // create tag inventory
  const tagInventory = {};
  // load etags map
  const etags = await parseFile(ETAG_FILE_PATH);
  const etagMap = etags ? new Map(Object.entries(etags)) : new Map();
  // populate cache
  const cacheFile = await parseFile(CACHE_FILE);
  const cache = cacheFile ? cacheFile : {};
  // if cache date, get tags since then
  const cacheTime = (RECHECK_ETAG || SKIP_CACHE) ? 0 : cache?.update_time ?? 0
  const newTags = await getAllTags(cacheTime);
  // iterate over tags
  const length = newTags.length;
  const totalbar = multibar.create(length, 0, { name: "Total", last: "" });
  totalbar.update({ name: "Total" });
  const dlbar = multibar.create(length, 0, { name: "Downloaded", last: "" });
  dlbar.update({ name: "Downloaded" });
  const skipbar = multibar.create(length, 0, { name: "Skipped", last: "" });
  skipbar.update({ name: "Skipped" });
  const stuffbar = multibar.create(length, 0, { name: "Stuffed", last: "" });
  stuffbar.update({ name: "Stuffed" });
  const altFiles = await getAltFiles(`${TAG_PATH}/alt/`);
  // get all files
  const allFiles = await getAllFiles();
  for (const tag of newTags) {
    totalbar.increment();
    const url = tag.image_path;
    // skip if default
    if (url.endsWith("&default=true")) continue;
    // set up names
    const tagName = tag.name;
    const fileName = cleanFileName(tagName);
    const filePath = `${TAG_PATH}/${fileName}`;
    // if raw file exists, delete (erroneous or leftover)
    fs.access(filePath)
      .then(() => fs.unlink(filePath))
      .catch(() => false);
    // check for existing files
    const imgFiles = await findFiles(fileName, IMG_FILETYPES);
    const vidFiles = await findFiles(fileName, VID_FILETYPES);
    const alt = altFiles.includes(fileName);
    if (imgFiles.length > 1) console.error("Multiple image files found:", imgFiles);
    if (vidFiles.length > 1) console.error("Multiple video files found:", vidFiles);
    // delete files from allFiles
    for (const file of [...imgFiles, ...vidFiles]) {
      allFiles.delete(file.split("/").pop());
    }
    const ignore = tag.ignore_auto_tag || EXCLUDE_PREFIX.some((prefix) => tagName.startsWith(prefix));
    tagInventory[tagName] = { img: imgFiles[0], vid: vidFiles[0], ignore, alt };
    // if no file, force download
    const force = !imgFiles.length && !vidFiles.length;
    if (!force && !etagMap.has(url)) { // try forcing etag if exists
      const forceEtag = await checksumFile(vidFiles[0] || imgFiles[0]);
      etagMap.set(url, `"${forceEtag}"`);
      stuffbar.increment({ last: tagName })
    } else if (!RECHECK_ETAG && etagMap.has(url)) { // if not forcedl, skip if exists in etags
      skipbar.increment({ last: tagName });
      continue;
    }
    // download file
    const response = await downloadFile(url, etagMap, force);
    if (response.status == 304) {
      skipbar.increment({ last: tagName });
    } else if (response.status == 200) {
      // get ext
      const ext = mime.getExtension(response.headers["content-type"]);
      dlbar.increment({ last: tagName });
      multibar.log("Downloading", tagName);
      const bufferData = Buffer.from(response.data, "binary");
      await fs.writeFile(filePath, bufferData);
      // rename file extension
      // ovewrites files of existing type, leaves previous types alone
      const extFileName = `${filePath}.${ext}`;
      fs.rename(filePath, extFileName);
      // push to tag inventory
      const fileType = VID_FILETYPES.includes(ext) ? "vid" : "img";
      tagInventory[tagName][fileType] = extFileName;
    }
  }
  multibar.stop()
  // update cache update_time
  cache.update_time = new Date().toISOString();
  fs.writeFile(CACHE_FILE, JSON.stringify(cache));
  // write etag map
  fs.writeFile(ETAG_FILE_PATH, JSON.stringify(Object.fromEntries(etagMap)));
  // finally, write tag inventory
  fs.writeFile(TAG_EXPORT_PATH, JSON.stringify(saniTagExports(tagInventory)));
  // print out extra files
  if (SKIP_CACHE) {
    for (const file of allFiles.values()) {
      console.log("Extra file found:", file);
     }
  }
  console.log("Tag export complete", cache.update_time);
}
main();

const routes = {
  'GET /update': async (req, res) => {
    main();
    res.sendJson({ message: new Date().toTimeString() });
  }
}
const PORT = process.env.PORT || 3000;
rs(routes).listen(PORT, () => console.log(`Listening on port ${PORT}`));
cron.schedule("0 0 * * *", main);