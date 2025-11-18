/////////////////////////////////////
// Photo Album backend
// nodejs, express api that handles images
// /api/upload:                       upload image to the IMAGE_FOLDER, this is configurable via .env file. the key is PHOTO_LIBRARY_LOCATION
// /api/thumb?name=xxx&w=400:         will show you the thumbnail image with width 400 for the given filename
// /api/image?name=xxxx:              will render the original file. with headers: Content-Type, Etag, Content-Length and Cache-Control
// /api/photo-album?limit=10&page=2:  will return a subset of images where you define the limit and what the current page is. You can sort on mtime or name and asc/desc. 
//                                    The response body contains the totalPages, total, limit, page and the items. An item consists of placeholder, name and thumbUrl
/////////////////////////////////////
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const sharp = require('sharp');
const mime = require('mime-types');
const multer = require('multer');
const dotenv = require('dotenv');

// == Server setup ==
const server =  express();
const apiContext = express();

dotenv.config();

server.use('/api', apiContext);

// == CONFIGURATION AND CONSTANTS ==

const PORT = process.env.PORT || 3000;
const IMAGE_FOLDER = path.resolve(process.env.PHOTO_LIBRARY_LOCATION);
const THUMB_CACHE_DIR = path.join(IMAGE_FOLDER, '.cache', 'thumbs');
const DEFAULT_THUMB_WIDTH = 400;
const PLACEHOLDER_WIDTH = 16;
const THUMB_QUALITY = 70;
const THUMB_MAX_AGE = 60 * 60 * 24 * 30; // 1 month or 30 days :D
const IMAGE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days or 1 week
const FIRST_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MTIME = 'mtime';
const NAME = 'name';
const SORT_ASC = 'asc';
const SORT_DESC = 'desc';
const MULTER_FILE_SIZE = 10 * 1024 * 1024; // 10 mb

// == HTTP status
const INTERNAL_SERVER_ERROR = 500;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const NOT_MODIFIED = 304;

// Http header keys
const IF_NONE_MATCH = 'if-none-match';
const CONTENT_TYPE = 'Content-Type';
const E_TAG = 'ETag';
const CACHE_CONTROL = 'Cache-Control';
const CONTENT_LENGTH = 'Content-Length';

// http header values
const IMAGES_JPEG = 'images/jpeg';

// make sure that the cache directory exists or needs to be created if it does not exists
fs.mkdirSync(THUMB_CACHE_DIR, {recursive: true});

// == UTILITIES ==

async function getFiles(sortBy = NAME, order = SORT_ASC) {
  const names = await fsp.readdir(IMAGE_FOLDER);
  const items = [];
  for (const name of names) {
    const filePath = path.join(IMAGE_FOLDER, name);
    try {
      const stat = await fsp.stat(filePath);
      // only list files
      if (stat.isFile()) {
        items.push({name, mtimeMs: stat.mtimeMs, size: stat.size});
      }
    } catch (err) {
      // ignore this because tjhe file is not readable!
    }
  }

  // we have all the files
  items.sort((itemA, itemB) => {
    let diff;
    if (sortBy === MTIME) {
      diff = a.mtimeMs - b.mtimeMs;
    } else {
      diff = a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
    }

    return order === SORT_ASC ? diff : -diff;
  });

  return items.map(i => i.name);
};

function safeJoin(name) {
  // to ensure that we will start from the root of the image folder directory
  const filePath = path.resolve(IMAGE_FOLDER, name);
  if (!fs.existsSync(filePath)) {
    throw Error('Invalid path!');
  }
  return filePath;
}

async function generatePlaceholder(name) {
  const filePath = safeJoin(name);
  const stat = await fsp.stat(filePath);
  const baseKey = crypto.createHash('sha1').update(`${name}:${stat.mtimeMs}`).digest('hex');
  const placeholder = path.join(THUMB_CACHE_DIR, `${baseKey}-placeholder.jpg`);

  if (fs.existsSync(placeholder)) {
    const buf = await fsp.readFile(placeholder);
    return `data:image/jpeg:base64:${buf.toString('base64')}`;
  }

  const buffer = await sharp(filePath)
                          .rotate()
                          .resize({width: PLACEHOLDER_WIDTH})
                          .blur()
                          .jpeg({quality: 40})
                          .toBuffer();

  await fsp.writeFile(placeholder, buffer);
  return `data:image/jpeg:base64,${buffer.toString('base64')}`;
};

// use size and mtimeMs for a stable e-tag
function computeEtag(stat) {
  const raw = `${stat.size}-${stat.mtimeMs}`;
  return crypto.createHash('sha1')
                .update(raw)
                .digest('hex');
}

const storage = multer.diskStorage(
  {
    destination: function (req, file, cb) {
      try {
        cb(null, IMAGE_FOLDER); // save uploaded images in this directory
      } catch (err) {
        console.log(`destination: ${err.message}`);
      }
    },
    filename: function (req, file, cb) {
      const suffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
      const extension = path.extname(file.originalname);
      try {
        cb(null, `${suffix}${extension}`);
      } catch (err) {
        console.log(`Storage: ${err.message}`);
      }
    }
  }
);

const upload = multer({
  storage,
  limits: { fileSize: MULTER_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Not supported mime typpe for  upload'));
    }
    try {
      cb(null, true);
    } catch (err) {
      console.log(`Upload error ${err.message}`);
    }
  }
});

// == REST API ==

// /api/photo-album will list the images based on the query parameters (pagination, sorting, placeholder)
apiContext.get('/photo-album', async (req, res) => {
  try {
    // if Number(req.query.page) === undefined than we are searching for the first page.
    const page = Math.max(1, Number(req.query.page) || FIRST_PAGE);
    // if Number(req.query.limit) === undefined than we are limiting it to 20
    const limit = Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT);
    const sortBy = req.query.sortBy === MTIME ? MTIME : NAME;
    const order = req.query.sort === SORT_ASC ? SORT_ASC : SORT_DESC;
    const allFiles = await getFiles(sortBy, order);
    const total = allFiles.length;
    const totalPages = Math.ceil(total, limit);
    const startPage = (page - 1) * limit;
    const slice = allFiles.slice(startPage, startPage + limit);
    // blur up fx, we want to generate on demand and cache thumbnails on disk, p/api/thumb?name=image-1763507899257-598061867&w=aceholders are derived
    const items = await Promise.all(slice.map(async (name) => {
      const thumbUrl = `/api/thumb?name=${encodeURIComponent(name)}&w=${DEFAULT_THUMB_WIDTH}`;
      try{
        // we need to generate the placeholders
        const placeholder = await generatePlaceholder(name);
        return {name, placeholder, thumbUrl};
      } catch(theFlue) {
        return {name, placeholder: null, thumbUrl}
      }
    }));
    res.json({ page, limit, total, totalPages, items });
  } catch(err) {
    console.error(err);
    res.status(INTERNAL_SERVER_ERROR).json({error: err.message});
  }
});

apiContext.get('/thumb', async (req, res) => {
  try {
    const name = req.query.name;
    const width = Math.max(16, Math.min(2000, Number(req.query.w) || DEFAULT_THUMB_WIDTH));
    // check if we pass the name key in the query parameters
    if (!name) {
      return res.status(BAD_REQUEST).json({error: `Missing ?name=${name}`});
    }

    const filePath = safeJoin(name);
    const stat = await fsp.stat(filePath);

    if (!stat.isFile()) {
      return res.status(NOT_FOUND).json({error: `File not found: ${name}`});
    }

    const thumbKey = crypto.createHash('sha1')
                            .update(`${name}:${width}:${stat.mtimeMs}`)
                            .digest('hex');

    const extension = path.extname(name).toLowerCase();
    const thumbFile = path.join(THUMB_CACHE_DIR, `${thumbKey}${extension || '.jpg'}`);

    if (fs.existsSync(thumbFile)) {
      const thumbStat = await fs.statSync(thumbFile);
      const etag = computeEtag(thumbStat);
      if (req.headers[IF_NONE_MATCH] === etag) {
        res.status(NOT_MODIFIED).end();
        return;
      }
      const mimeType = mime.lookup(thumbFile) || IMAGES_JPEG;
      res.setHeader(CONTENT_TYPE, mimeType);
      res.setHeader(E_TAG, etag);
      res.setHeader(CACHE_CONTROL, `public, max-age=${THUMB_MAX_AGE}`);
      return fs.createReadStream(thumbFile).pipe(res);
    }
    
    await sharp(filePath)
            .rotate()
            .resize({ width, withoutEnlargement: true })
            .jpeg({ quality: THUMB_QUALITY })
            .toFile(thumbFile);

    const thumbStat = await fsp.stat(thumbFile);
    const etag = computeEtag(thumbStat);
    res.setHeader(CONTENT_TYPE, 'image/jpeg');
    res.setHeader(E_TAG, etag);
    res.setHeader(CACHE_CONTROL, `public, max-age=${THUMB_MAX_AGE}`);
    fs.createReadStream(thumbFile).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(INTERNAL_SERVER_ERROR).json({error: err.message});
  }
});

apiContext.get('/image', async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) {
      return res.status(BAD_REQUEST).json({error: 'Missing ?name'});
    }

    const filePath = safeJoin(IMAGE_FOLDER, name);
    const stat = await fs.stat(filePath);

    if (!stat.isFile()) {
      return res.status(NOT_FOUND).json({error: `File ${name} not found`});
    }
    const etag = computeEtag(stat);
    if (req.headers[IF_NONE_MATCH] === etag) {
      res.status(NOT_MODIFIED).end();
      return;
    }
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    res.setHeader(CONTENT_TYPE, mimeType);
    res.setHeader(CONTENT_LENGTH, stat.size);
    res.setHeader(E_TAG, etag);
    res.setHeader(CACHE_CONTROL, `public, max-age=${IMAGE_MAX_AGE}`);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.status(NOT_FOUND).send({error: 'File not found'}));
    stream.pipe(res);
  } catch(err) {
    console.error(err);
    res.status(INTERNAL_SERVER_ERROR).json({error: err.message});
  }
});

apiContext.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(BAD_REQUEST).json({error: 'No file uploaded'});
    }

    await generatePlaceholder(req.file.filename);
    res.json({
      message: 'Upload successful',
      filename: req.file.filename,
      thumbUrl: `/api/thumb?name=${encodeURIComponent(req.file.filename)}&w=${DEFAULT_THUMB_WIDTH}`
    });
  } catch (err) {
    console.error(err);
    res.status(INTERNAL_SERVER_ERROR).json({error: err.message});
  }
});

// == SERVER STARTUP ==
server.listen(PORT, () => {
  console.log(`Server started on port: ${PORT}`);
});
