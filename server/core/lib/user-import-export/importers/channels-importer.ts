import { ActorImageType, ChannelExportJSON } from '@peertube/peertube-models'
import { logger, loggerTagsFactory } from '@server/helpers/logger.js'
import { pick } from '@peertube/peertube-core-utils'
import { AbstractUserImporter } from './abstract-user-importer.js'
import { sequelizeTypescript } from '@server/initializers/database.js'
import { createLocalVideoChannel } from '@server/lib/video-channel.js'
import { JobQueue } from '@server/lib/job-queue/job-queue.js'
import { updateLocalActorImageFiles } from '@server/lib/local-actor.js'
import { VideoChannelModel } from '@server/models/video/video-channel.js'
import {
  isVideoChannelDescriptionValid,
  isVideoChannelDisplayNameValid,
  isVideoChannelSupportValid,
  isVideoChannelUsernameValid
} from '@server/helpers/custom-validators/video-channels.js'
import { CONSTRAINTS_FIELDS } from '@server/initializers/constants.js'

const lTags = loggerTagsFactory('user-import')

export class ChannelsImporter extends AbstractUserImporter <ChannelExportJSON, ChannelExportJSON['channels'][0]> {

  protected getImportObjects (json: ChannelExportJSON) {
    return json.channels
  }

  protected sanitize (blocklistImportData: ChannelExportJSON['channels'][0]) {
    if (!isVideoChannelUsernameValid(blocklistImportData.name)) return undefined
    if (!isVideoChannelDisplayNameValid(blocklistImportData.name)) return undefined

    if (!isVideoChannelDescriptionValid(blocklistImportData.description)) blocklistImportData.description = null
    if (!isVideoChannelSupportValid(blocklistImportData.support)) blocklistImportData.description = null

    return blocklistImportData
  }

  protected async importObject (channelImportData: ChannelExportJSON['channels'][0]) {
    const account = this.user.Account
    const existingChannel = await VideoChannelModel.loadLocalByNameAndPopulateAccount(channelImportData.name)

    if (existingChannel) {
      logger.info(`Do not import channel ${existingChannel.name} that already exists on this PeerTube instance`, lTags())
    } else {
      const videoChannelCreated = await sequelizeTypescript.transaction(async t => {
        return createLocalVideoChannel(pick(channelImportData, [ 'displayName', 'name', 'description', 'support' ]), account, t)
      })

      await JobQueue.Instance.createJob({ type: 'actor-keys', payload: { actorId: videoChannelCreated.actorId } })

      for (const type of [ ActorImageType.AVATAR, ActorImageType.BANNER ]) {
        const relativePath = type === ActorImageType.AVATAR
          ? channelImportData.archiveFiles.avatar
          : channelImportData.archiveFiles.banner

        if (!relativePath) continue

        const absolutePath = this.getSafeArchivePathOrThrow(relativePath)
        if (!await this.isFileValidOrLog(absolutePath, CONSTRAINTS_FIELDS.ACTORS.IMAGE.FILE_SIZE.max)) continue

        await updateLocalActorImageFiles({
          accountOrChannel: videoChannelCreated,
          imagePhysicalFile: { path: absolutePath },
          type,
          sendActorUpdate: false
        })
      }

      logger.info('Video channel %s imported.', channelImportData.name, lTags())
    }

    return {
      duplicate: !!existingChannel
    }
  }
}
