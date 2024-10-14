import axios from "axios";
import fs from "fs/promises";
import { createReadStream } from "fs";
import * as https from "https";
import { fileTypeFromFile } from "file-type";
import cliProgress from "cli-progress";
import crypto from "crypto";

const APIKEY = process.env.STASH_APIKEY;
const STASH_URL = process.env.STASH_URL;
const TAG_PATH = process.env.TAG_PATH || "./tags";
const CACHE_PATH = process.env.CACHE_PATH || "./cache";
const IMG_FILETYPES = ["jpg", "png", "webp", "svg"];
const VID_FILETYPES = ["mp4", "webm"];
const ETAG_FILE_PATH = `${CACHE_PATH}/etags.json`;
const TAG_EXPORT_PATH = process.env.TAG_EXPORT_PATH || `${CACHE_PATH}/tags-export.json`;
const EXCLUDE_PREFIX = ["r:", "c:", ".", "stashdb", "Figure", "["]

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
async function getAllTags() {
  const query = `query FindTags {
    findTags(filter: { per_page: -1 }) {
        tags {
            name
            image_path
            id
            ignore_auto_tag
    }}}`;
  const response = await agent.post(
    STASH_URL,
    { query },
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

async function renameFileExt(filename) {
  const type = await fileTypeFromFile(filename);
  if (!type) {
    console.error("File type not found:", filename);
    return;
  }
  // extension overrides
  const ext = type.ext == "xml" ? "svg" : type.ext;
  const newname = `${filename}.${ext}`;
  fs.rename(filename, newname);
  return newname;
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

// main function
async function main() {
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  // create tag inventory
  let skipped = 0;
  let downloaded = 0;
  const tagInventory = {};
  // load etags map
  const etags = await fs.access(ETAG_FILE_PATH)
    .then(async () => JSON.parse(await fs.readFile(ETAG_FILE_PATH)))
    .catch(() => {});
  const etagMap = etags ? new Map(Object.entries(etags)) : new Map();
  const newTags = await getAllTags();
  // iterate over tags
  bar.start(newTags.length, 0);
  for (const tag of newTags) {
    bar.increment();
    const url = tag.image_path;
    // skip if default
    if (url.endsWith("&default=true")) continue;
    // set up names
    const tagName = cleanFileName(tag.name);
    const fileName = `${TAG_PATH}/${tagName}`;
    // if raw file exists, delete (erroneous or leftover)
    fs.access(fileName)
      .then(() => fs.unlink(fileName))
      .catch(() => false);
    // check for existing files
    const imgFiles = await findFiles(tagName, IMG_FILETYPES);
    const vidFiles = await findFiles(tagName, VID_FILETYPES);
    if (imgFiles.length > 1) console.error("Multiple image files found:", imgFiles);
    if (vidFiles.length > 1) console.error("Multiple video files found:", vidFiles);
    const ignore = tag.ignore_auto_tag || EXCLUDE_PREFIX.some((prefix) => tag.name.startsWith(prefix));
    tagInventory[tag.name] = { img: imgFiles[0], vid: vidFiles[0], ignore };
    // if no file, force download
    const force = !imgFiles.length && !vidFiles.length;
    if (!force && !etagMap.has(url)) { // try forcing etag if exists
      const forceEtag = await checksumFile(vidFiles[0] || imgFiles[0]);
      console.log("Stuffing etag")
      etagMap.set(url, forceEtag);
    }
    // download file
    const response = await downloadFile(url, etagMap, force);
    if (response.status == 304) {
      skipped++;
    } else if (response.status == 200) {
      console.log(`Downloading tag: ${tag.name}`);
      downloaded++;
      const bufferData = Buffer.from(response.data, "binary");
      await fs.writeFile(fileName, bufferData);
      // rename file extension
      // ovewrites files of existing type, leaves previous types alone
      const extFileName = await renameFileExt(fileName);
      // push to tag inventory
      const ext = extFileName.split(".").pop()
      const fileType = VID_FILETYPES.includes(ext) ? "vid" : "img";
      tagInventory[tag.name][fileType] = extFileName;
    }
  }
  bar.stop()
  console.log("Downloaded:", downloaded, "Skipped:", skipped);
  // write etag map
  fs.writeFile(ETAG_FILE_PATH, JSON.stringify(Object.fromEntries(etagMap)));
  // finally, write tag inventory
  fs.writeFile(TAG_EXPORT_PATH, JSON.stringify(saniTagExports(tagInventory)));
}
main();