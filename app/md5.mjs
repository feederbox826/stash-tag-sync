import crypto from "crypto";
import { createReadStream } from "fs";

export const checksumFile = (path) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = createReadStream(path);
    stream.on('error', err => reject(err));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });