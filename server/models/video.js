'use strict'

const createTorrent = require('create-torrent')
const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs')
const magnetUtil = require('magnet-uri')
const parallel = require('async/parallel')
const parseTorrent = require('parse-torrent')
const pathUtils = require('path')
const mongoose = require('mongoose')

const constants = require('../initializers/constants')
const customVideosValidators = require('../helpers/custom-validators').videos
const logger = require('../helpers/logger')
const modelUtils = require('./utils')

// ---------------------------------------------------------------------------

// TODO: add indexes on searchable columns
const VideoSchema = mongoose.Schema({
  name: String,
  extname: {
    type: String,
    enum: [ '.mp4', '.webm', '.ogv' ]
  },
  remoteId: mongoose.Schema.Types.ObjectId,
  description: String,
  magnet: {
    infoHash: String
  },
  podUrl: String,
  author: String,
  duration: Number,
  thumbnail: String,
  tags: [ String ],
  createdDate: {
    type: Date,
    default: Date.now
  }
})

VideoSchema.path('name').validate(customVideosValidators.isVideoNameValid)
VideoSchema.path('description').validate(customVideosValidators.isVideoDescriptionValid)
VideoSchema.path('podUrl').validate(customVideosValidators.isVideoPodUrlValid)
VideoSchema.path('author').validate(customVideosValidators.isVideoAuthorValid)
VideoSchema.path('duration').validate(customVideosValidators.isVideoDurationValid)
// The tumbnail can be the path or the data in base 64
// The pre save hook will convert the base 64 data in a file on disk and replace the thumbnail key by the filename
VideoSchema.path('thumbnail').validate(function (value) {
  return customVideosValidators.isVideoThumbnailValid(value) || customVideosValidators.isVideoThumbnail64Valid(value)
})
VideoSchema.path('tags').validate(customVideosValidators.isVideoTagsValid)

VideoSchema.methods = {
  generateMagnetUri,
  getVideoFilename,
  getThumbnailName,
  getPreviewName,
  getTorrentName,
  isOwned,
  toFormatedJSON,
  toRemoteJSON
}

VideoSchema.statics = {
  getDurationFromFile,
  listForApi,
  listByUrlAndRemoteId,
  listByUrl,
  listOwned,
  listOwnedByAuthor,
  listRemotes,
  load,
  search
}

VideoSchema.pre('remove', function (next) {
  const video = this
  const tasks = []

  tasks.push(
    function (callback) {
      removeThumbnail(video, callback)
    }
  )

  if (video.isOwned()) {
    tasks.push(
      function (callback) {
        removeFile(video, callback)
      },
      function (callback) {
        removeTorrent(video, callback)
      },
      function (callback) {
        removePreview(video, callback)
      }
    )
  }

  parallel(tasks, next)
})

VideoSchema.pre('save', function (next) {
  const video = this
  const tasks = []

  if (video.isOwned()) {
    const videoPath = pathUtils.join(constants.CONFIG.STORAGE.VIDEOS_DIR, video.getVideoFilename())
    this.podUrl = constants.CONFIG.WEBSERVER.HOSTNAME + ':' + constants.CONFIG.WEBSERVER.PORT

    tasks.push(
      // TODO: refractoring
      function (callback) {
        const options = {
          announceList: [
            [ constants.CONFIG.WEBSERVER.WS + '://' + constants.CONFIG.WEBSERVER.HOSTNAME + ':' + constants.CONFIG.WEBSERVER.PORT + '/tracker/socket' ]
          ],
          urlList: [
            constants.CONFIG.WEBSERVER.URL + constants.STATIC_PATHS.WEBSEED + video.getVideoFilename()
          ]
        }

        createTorrent(videoPath, options, function (err, torrent) {
          if (err) return callback(err)

          fs.writeFile(constants.CONFIG.STORAGE.TORRENTS_DIR + video.getTorrentName(), torrent, function (err) {
            if (err) return callback(err)

            const parsedTorrent = parseTorrent(torrent)
            video.magnet.infoHash = parsedTorrent.infoHash

            console.log(parsedTorrent)
            callback(null)
          })
        })
      },
      function (callback) {
        createThumbnail(video, videoPath, callback)
      },
      function (callback) {
        createPreview(video, videoPath, callback)
      }
    )

    parallel(tasks, next)
  } else {
    generateThumbnailFromBase64(video, video.thumbnail, next)
  }
})

mongoose.model('Video', VideoSchema)

// ------------------------------ METHODS ------------------------------

function generateMagnetUri () {
  let baseUrlHttp, baseUrlWs

  if (this.isOwned()) {
    baseUrlHttp = constants.CONFIG.WEBSERVER.URL
    baseUrlWs = constants.CONFIG.WEBSERVER.WS + '://' + constants.CONFIG.WEBSERVER.HOSTNAME + ':' + constants.CONFIG.WEBSERVER.PORT
  } else {
    baseUrlHttp = constants.REMOTE_SCHEME.HTTP + this.podUrl
    baseUrlWs = constants.REMOTE_SCHEME.WS + this.podUrl
  }

  const xs = baseUrlHttp + constants.STATIC_PATHS.TORRENTS + this.getTorrentName()
  const announce = baseUrlWs + '/tracker/socket'
  const urlList = [ baseUrlHttp + constants.STATIC_PATHS.WEBSEED + this.getVideoFilename() ]

  const magnetHash = {
    xs,
    announce,
    urlList,
    infoHash: this.magnet.infoHash,
    name: this.name
  }

  return magnetUtil.encode(magnetHash)
}

function getVideoFilename () {
  if (this.isOwned()) return this._id + this.extname

  return this.remoteId + this.extname
}

function getThumbnailName () {
  // We always have a copy of the thumbnail
  return this._id + '.jpg'
}

function getPreviewName () {
  const extension = '.jpg'

  if (this.isOwned()) return this._id + extension

  return this.remoteId + extension
}

function getTorrentName () {
  const extension = '.torrent'

  if (this.isOwned()) return this._id + extension

  return this.remoteId + extension
}

function isOwned () {
  return this.remoteId === null
}

function toFormatedJSON () {
  const json = {
    id: this._id,
    name: this.name,
    description: this.description,
    podUrl: this.podUrl,
    isLocal: this.isOwned(),
    magnetUri: this.generateMagnetUri(),
    author: this.author,
    duration: this.duration,
    tags: this.tags,
    thumbnailPath: constants.STATIC_PATHS.THUMBNAILS + '/' + this.getThumbnailName(),
    createdDate: this.createdDate
  }

  return json
}

function toRemoteJSON (callback) {
  const self = this

  // Convert thumbnail to base64
  const thumbnailPath = pathUtils.join(constants.CONFIG.STORAGE.THUMBNAILS_DIR, this.getThumbnailName())
  fs.readFile(thumbnailPath, function (err, thumbnailData) {
    if (err) {
      logger.error('Cannot read the thumbnail of the video')
      return callback(err)
    }

    const remoteVideo = {
      name: self.name,
      description: self.description,
      magnet: self.magnet,
      remoteId: self._id,
      author: self.author,
      duration: self.duration,
      thumbnailBase64: new Buffer(thumbnailData).toString('base64'),
      tags: self.tags,
      createdDate: self.createdDate,
      podUrl: self.podUrl
    }

    return callback(null, remoteVideo)
  })
}

// ------------------------------ STATICS ------------------------------

function getDurationFromFile (videoPath, callback) {
  ffmpeg.ffprobe(videoPath, function (err, metadata) {
    if (err) return callback(err)

    return callback(null, Math.floor(metadata.format.duration))
  })
}

function listForApi (start, count, sort, callback) {
  const query = {}
  return modelUtils.listForApiWithCount.call(this, query, start, count, sort, callback)
}

function listByUrlAndRemoteId (fromUrl, remoteId, callback) {
  this.find({ podUrl: fromUrl, remoteId: remoteId }, callback)
}

function listByUrl (fromUrl, callback) {
  this.find({ podUrl: fromUrl }, callback)
}

function listOwned (callback) {
  // If remoteId is null this is *our* video
  this.find({ remoteId: null }, callback)
}

function listOwnedByAuthor (author, callback) {
  this.find({ remoteId: null, author: author }, callback)
}

function listRemotes (callback) {
  this.find({ remoteId: { $ne: null } }, callback)
}

function load (id, callback) {
  this.findById(id, callback)
}

function search (value, field, start, count, sort, callback) {
  const query = {}
  // Make an exact search with the magnet
  if (field === 'magnetUri' || field === 'tags') {
    query[field] = value
  } else {
    query[field] = new RegExp(value, 'i')
  }

  modelUtils.listForApiWithCount.call(this, query, start, count, sort, callback)
}

// ---------------------------------------------------------------------------

function removeThumbnail (video, callback) {
  fs.unlink(constants.CONFIG.STORAGE.THUMBNAILS_DIR + video.getThumbnailName(), callback)
}

function removeFile (video, callback) {
  fs.unlink(constants.CONFIG.STORAGE.VIDEOS_DIR + video.getVideoFilename(), callback)
}

function removeTorrent (video, callback) {
  fs.unlink(constants.CONFIG.STORAGE.TORRENTS_DIR + video.getTorrentName(), callback)
}

function removePreview (video, callback) {
  // Same name than video thumnail
  fs.unlink(constants.CONFIG.STORAGE.PREVIEWS_DIR + video.getPreviewName(), callback)
}

function createPreview (video, videoPath, callback) {
  generateImage(video, videoPath, constants.CONFIG.STORAGE.PREVIEWS_DIR, video.getPreviewName(), callback)
}

function createThumbnail (video, videoPath, callback) {
  generateImage(video, videoPath, constants.CONFIG.STORAGE.THUMBNAILS_DIR, video.getThumbnailName(), constants.THUMBNAILS_SIZE, callback)
}

function generateThumbnailFromBase64 (video, thumbnailData, callback) {
  // Creating the thumbnail for this remote video)

  const thumbnailName = video.getThumbnailName()
  const thumbnailPath = constants.CONFIG.STORAGE.THUMBNAILS_DIR + thumbnailName
  fs.writeFile(thumbnailPath, thumbnailData, { encoding: 'base64' }, function (err) {
    if (err) return callback(err)

    return callback(null, thumbnailName)
  })
}

function generateImage (video, videoPath, folder, imageName, size, callback) {
  const options = {
    filename: imageName,
    count: 1,
    folder
  }

  if (!callback) {
    callback = size
  } else {
    options.size = size
  }

  ffmpeg(videoPath)
    .on('error', callback)
    .on('end', function () {
      callback(null, imageName)
    })
    .thumbnail(options)
}
