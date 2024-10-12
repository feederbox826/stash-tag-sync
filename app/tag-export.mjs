import axios from "axios";
import fs from "fs/promises";
import * as https from "https";
import { fileTypeFromFile } from "file-type";

const APIKEY = process.env.STASH_APIKEY;
const STASH_URL = process.env.STASH_URL;
const TAG_PATH = process.env.TAG_PATH || "./tags";
const CACHE_PATH = process.env.CACHE_PATH || "./cache";
const DELETE_EXISTING = process.env.DELETE_EXISTING || false;
const FILETYPES = ["jpg", "png", "webp", "svg", "webm"];
const TAG_FILE_PATH = `${CACHE_PATH}/tags.json`;
const TEMP_TAG_FILE_PATH = `${CACHE_PATH}/temp-tags.json`;

// setup axios agenw tihout TLS verification
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
    }}}`;
  const response = await agent.post(
    STASH_URL,
    { query },
  ).catch(err => err.response);
  return response.data.data.findTags.tags;
}

async function downloadFile(url, filename) {
  const response = await agent.get(url, {
    method: "GET",
    responseType: "arraybuffer",
    responseEncoding: "binary",
  }).catch(err => err.response);
  const bufferData = Buffer.from(response.data, "binary");
  return await fs.writeFile(filename, bufferData);
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
  // dedupe
  const deduped = [...new Set(tagExports)];
  // remove trailing `./` and reduce to basename
  return deduped.map((tag) => ({ name: tag.name, filename: tag.filename.split("/").pop() }));
}

// main function
async function main() {
  // create tag inventory
  const tagInventory = [];
  const newTags = await getAllTags();
  // save tags to cache
  fs.writeFile(TEMP_TAG_FILE_PATH, JSON.stringify(newTags));
  const oldTags = await fs.access(TAG_FILE_PATH)
    .then(async () => JSON.parse(await fs.readFile(TAG_FILE_PATH)))
    .catch(() => []);
  let tagQueue = [];
  for (const tag of newTags) {
    // skip if default
    if (tag.image_path.endsWith("&default=true")) continue;
    // if DNE, add to queue
    const tagName = cleanFileName(tag.name);
    // check for jpg, png, webm
    let filePath = false;
    for (const ext of FILETYPES) {
      const filename = `${TAG_PATH}/${tagName}.${ext}`;
      const isFile = await fs.access(filename)
        .then(() => true)
        .catch(() => false)
      if (isFile) {
        filePath = filename;
        // push to tag inventory as existing file
        tagInventory.push({ name: tag.name, filename: filePath });
        break;
      }
    }
    // if raw file exists, delete
    fs.access(`${TAG_PATH}/${tagName}`)
      .then(() => fs.unlink(`${TAG_PATH}/${tagName}`))
      .catch(() => false);
    if (!filePath) tagQueue.push(tag);
    // if url differs, add to queue and delete old tag
    if (!oldTags.find((oldTag) => oldTag.image_path === tag.image_path)) {
      if (filePath && DELETE_EXISTING == "TRUE") fs.unlink(filePath);
      tagQueue.push(tag);
    }
  }
  fs.rename(TEMP_TAG_FILE_PATH, TAG_FILE_PATH);
  console.log("Tag queue length:", tagQueue.length);
  for (const tag of tagQueue) {
    try {
      console.log(tag);
      // download file
      const fileName = `${TAG_PATH}/${cleanFileName(tag.name)}`;
      const url = tag.image_path;
      await downloadFile(url, fileName);
      // rename file extension
      const extFileName = await renameFileExt(fileName);
      // push to tag inventory
      tagInventory.push({ name: tag.name, filename: extFileName });
    } catch(err) {
      console.error("Error downloading file:", tag, err);
    }
  }
  // finally, write tag inventory
  fs.writeFile(`${CACHE_PATH}/tags-export.json`, JSON.stringify(saniTagExports(tagInventory)));
}
main();
