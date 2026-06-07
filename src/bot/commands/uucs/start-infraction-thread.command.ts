import { Command, Handler, InteractionEvent } from '@discord-nestjs/core';
import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  ChannelType,
  ForumChannel,
  EmbedBuilder,
  ThreadChannel,
} from 'discord.js';
import { InjectDb } from 'nest-mongodb';
import * as mongo from 'mongodb';

@Command({
  name: 'Start forum thread',
  type: ApplicationCommandType.Message,
})
export class StartInfractionForumThreadCommand {
  constructor(@InjectDb() private readonly db: mongo.Db) {}

  @Handler()
  async onStartThread(
    @InteractionEvent() interaction: MessageContextMenuCommandInteraction,
  ): Promise<void> {
    if (!interaction.isMessageContextMenuCommand()) return;

    await interaction.deferReply({ ephemeral: true });

    try {
      const targetMessage = interaction.targetMessage;

      // Find the infraction by targetMessage.id
      const infraction = await this.db
        .collection('infractions')
        .findOne({ discordWarningMessageId: targetMessage.id });

      if (!infraction) {
        await interaction.editReply({
          content: 'This message is not recognized as a registered infraction warning post.',
        });
        return;
      }

      if (infraction.threadUrl) {
        await interaction.editReply({
          content: `This infraction already has a forum thread attached: ${infraction.threadUrl}`,
        });
        return;
      }

      // Fetch config
      const config = await this.db.collection('configs').findOne({});
      const infractionForumChannelId = config?.infractionForumChannelId;

      if (!infractionForumChannelId) {
        await interaction.editReply({
          content: 'No infraction forum channel has been configured by the admins on the website.',
        });
        return;
      }

      // Fetch the forum channel
      const forumChannel = await interaction.guild.channels.fetch(infractionForumChannelId).catch(() => null);

      if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
        await interaction.editReply({
          content: `Could not find the configured forum channel (ID: ${infractionForumChannelId}) or it is not a Forum channel.`,
        });
        return;
      }

      // Fetch target user to get username
      const targetUser = await interaction.client.users.fetch(infraction.targetDiscordId).catch(() => null);
      const targetUsername = targetUser ? targetUser.username : (infraction.targetDiscordId || 'Unknown');

      const threadName = `Infraction - ${targetUsername} - Rule ${infraction.ruleId || 'N/A'}`;

      let threadContent = `**Infraction Discussion Thread**\n`;
      threadContent += `**Target User:** <@${infraction.targetDiscordId}>\n`;
      threadContent += `**Issued By:** <@${infraction.staffDiscordId}>\n`;
      threadContent += `**Type:** ${infraction.type}\n`;
      threadContent += `**Rule:** Rule ${infraction.ruleId}\n`;
      if (infraction.durationMinutes) {
        threadContent += `**Duration:** ${infraction.durationMinutes / 60} Hours\n`;
      }
      threadContent += `**Reason:** ${infraction.reason || 'No remarks provided'}\n`;
      if (infraction.evidenceUrls && infraction.evidenceUrls.length > 0) {
        threadContent += `**Evidence:**\n` + infraction.evidenceUrls.join('\n') + '\n';
      }
      threadContent += `**Warning Message:** https://discord.com/channels/${interaction.guildId}/${targetMessage.channelId}/${targetMessage.id}\n`;

      // Create thread in the forum channel
      const thread = await (forumChannel as ForumChannel).threads.create({
        name: threadName.substring(0, 100),
        message: {
          content: threadContent,
        },
        reason: `Start infraction forum thread requested by ${interaction.user.tag}`,
      }) as ThreadChannel;

      // Update DB
      await this.db.collection('infractions').updateOne(
        { _id: infraction._id },
        { $set: { threadUrl: thread.url } }
      );

      // Edit original message embed if possible
      const originalEmbed = targetMessage.embeds[0];
      if (originalEmbed) {
        const embed = EmbedBuilder.from(originalEmbed);
        const hasThreadField = embed.data.fields?.some((f) => f.name === 'Discussion Thread');
        if (!hasThreadField) {
          embed.addFields({ name: 'Discussion Thread', value: `[Join Thread](${thread.url})` });
          await targetMessage.edit({ embeds: [embed] });
        }
      }

      await interaction.editReply({
        content: `Successfully started and attached forum thread: ${thread.url}`,
      });
    } catch (error: any) {
      console.error('Start Infraction Thread Error:', error);
      await interaction.editReply({
        content: `An error occurred while starting the forum thread: ${error.message}`,
      });
    }
  }
}
