import axios from "axios";
import fs from "fs/promises";
import * as https from "https";
import cliProgress from "cli-progress";
import rs from "route-serve";
import cron from "node-cron";
import { imageSizeFromFile } from "image-size/fromFile";
import 'dotenv/config';

// config
const APIKEY = process.env.STASH_APIKEY;
const STASH_URL = process.env.STASH_URL;
const TAG_PATH = process.env.TAG_PATH || "./tags";
const CACHE_PATH = process.env.CACHE_PATH || "./cache";
const IMG_FILETYPES = ["jpg", "png", "webp", "svg"];
const VID_FILETYPES = ["mp4", "webm"];
const TAG_EXPORT_PATH = process.env.TAG_EXPORT_PATH || `${CACHE_PATH}/tags-export.json`;
const EXCLUDE_PREFIX = ["r:", "c:", ".", "stashdb", "Figure", "["]

const STASHDB_URL = "https://stashdb.org/graphql"

// setup axios agent without TLS verification
const stashAgent = axios.create({
  headers: { 'ApiKey': APIKEY },
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
})

// get all performers
async function getAllTags() {
  const query = `query {
    findTags(filter: { per_page: -1 }) {
    tags {
      name aliases image_path id ignore_auto_tag
      stash_ids {
        stash_id
        endpoint
      }
    }}}`;
  const response = await stashAgent.post(
    STASH_URL,
    { query }
  ).catch(err => err.response);
  return response.data.data.findTags.tags;
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

// main function
async function main() {
  console.log("Starting tag sync");
  const progress = new cliProgress.SingleBar({
    format: " {bar} {percentage}% | {value}/{total}"
  }, cliProgress.Presets.shades_classic);
  // create tag inventory
  const tagInventory = {};
  // get all tags
  const newTags = await getAllTags();
  // iterate over tags
  const length = newTags.length;
  progress.start(length, 0);
  const altFiles = await getAltFiles(`${TAG_PATH}/alt/`);
  // get all files
  const allFiles = await getAllFiles();
  for (const tag of newTags) {
    progress.increment();
    const url = tag.image_path;
    // skip if default
    if (url.endsWith("&default=true")) continue;
    // set up names
    const tagName = tag.name;
    // get stashID
    const stashID = tag?.stash_ids.find(s => s.endpoint === STASHDB_URL)?.stash_id
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
    // get image dimensions
    const dimensions = imgFiles.length ? await imageSizeFromFile(`${imgFiles[0]}`) : null;
    const ignore = tag.ignore_auto_tag || EXCLUDE_PREFIX.some((prefix) => tagName.startsWith(prefix));
    // error if not ignore and no stashid
    if (!ignore && !stashID) {
      console.error("No stashID found for tag:", tagName);
    };
    tagInventory[tagName] = { img: imgFiles[0], vid: vidFiles[0], ignore, alt, imgDimensions: dimensions, aliases: tag.aliases, stashID };
  }
  // finally, write tag inventory
  const saniExport = saniTagExports(tagInventory);
  fs.writeFile(TAG_EXPORT_PATH, JSON.stringify(saniExport));
  // print out extra files
  for (const file of allFiles.values()) {
    console.log("Extra file found:", file);
  }
  // print out tags without stashids
  const nosttashids = Object.entries(tagInventory)
    .filter(([_, value]) => !value.stashID && !value.ignore)
    .map(([key, _]) => key);
  if (nosttashids.length) {
    console.log("Tags without stashIDs:", nosttashids);
  }
  console.log("Tag export complete", new Date().toISOString());
  return saniTagExports(saniExport);
}
main();

const routes = {
  'GET /update/await': async (req, res) => {
    const result = await main();
    res.sendJson(result);
  },
  'GET /update': async (req, res) => {
    main();
    res.sendJson({ message: new Date().toTimeString() });
  }
}
const PORT = process.env.PORT || 3000;
rs(routes).listen(PORT, () => console.log(`Listening on port ${PORT}`));
cron.schedule("0 0 * * *", main);