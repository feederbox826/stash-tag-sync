import fs from "fs/promises";

const allFiles = (tagExports) => {
  const files = [];
  for (const [key, value] of Object.entries(tagExports)) {
    files.push(value["img"]);
    files.push(value["vid"]);
  }
  return files;
}

async function main() {
  const exportFiles = await fs.readFile("tags-export.json", "utf8")
    .then(JSON.parse)
    .then(allFiles)
  const tagFiles = await fs.readdir("media/original");
  const missingFiles = tagFiles.filter(file => !exportFiles.includes(file));
  console.log("Extra files:", missingFiles);
}
main()