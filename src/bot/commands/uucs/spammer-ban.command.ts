import { SlashCommandPipe } from '@discord-nestjs/common';
import {
  Command,
  Handler,
  InteractionEvent,
  Param,
  ParamType,
  EventParams,
} from '@discord-nestjs/core';
import {
  ChatInputCommandInteraction,
  ClientEvents,
  GuildMember,
} from 'discord.js';
import axios from 'axios';

class SpammerBanSlashCommandParams {
  @Param({ description: 'User to spammer ban', required: true, type: ParamType.USER })
  user: string;

  @Param({
    description: 'Reason / Remarks for the spammer ban',
    required: true,
    type: ParamType.STRING,
  })
  reason: string;

  @Param({
    description: 'Message Link or ID to associate with this spammer ban as evidence',
    required: false,
    type: ParamType.STRING,
  })
  message?: string;
}

@Command({
  name: 'spammer-ban',
  description: 'Issues a Spammer Ban to a user on Discord',
})
export class SpammerBanCommand {
  @Handler()
  async onSpammerBan(
    @InteractionEvent(SlashCommandPipe) options: SpammerBanSlashCommandParams,
    @EventParams() args: ClientEvents['interactionCreate'],
  ): Promise<void> {
    const interaction = args[0] as ChatInputCommandInteraction;
    const member = interaction.member as GuildMember;
    const guild = interaction.guild;

    if (!member) {
      await interaction.reply({
        content: 'Unable to determine member. Please try again.',
        ephemeral: true,
      });
      return;
    }

    // Permission check: Admin or Discord Moderator roles
    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const isAdmin = member.roles.cache.has(adminRoleId);
    const isDiscordMod = member.roles.cache.some((r) =>
      r.name.toLowerCase().includes('moderator'),
    );

    if (!isAdmin && !isDiscordMod) {
      await interaction.reply({
        content: 'You do not have permission to run this command. (Admins and Discord Moderators only)',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const targetUserId = options.user;
      const reason = options.reason;

      const evidenceUrls: string[] = [];

      let discordMessageId = null;
      if (options.message) {
        let channelId = null;
        let messageId = null;
        const match = options.message.match(/channels\/\d+\/(\d+)\/(\d+)/);
        if (match) {
          channelId = match[1];
          messageId = match[2];
        } else {
          messageId = options.message.trim();
        }

        discordMessageId = messageId;

        try {
          let targetMsg = null;
          if (channelId) {
            const channel = guild.channels.cache.get(channelId);
            if (channel && channel.isTextBased()) {
              targetMsg = await channel.messages.fetch(messageId).catch(() => null);
            }
          } else {
            targetMsg = await interaction.channel.messages.fetch(messageId).catch(() => null);
          }

          if (targetMsg && targetMsg.attachments.size > 0) {
            targetMsg.attachments.forEach((att: any) => {
              if (att.url && !evidenceUrls.includes(att.url)) {
                evidenceUrls.push(att.url);
              }
            });
          }
        } catch (err) {
          console.error('Failed to auto-archive target message attachments:', err);
        }
      }

      // Fetch target user to make sure they exist
      const targetUser = await interaction.client.users
        .fetch(targetUserId)
        .catch(() => null);
      if (!targetUser) {
        await interaction.editReply({
          content: `Could not find target user with ID: ${targetUserId}`,
        });
        return;
      }

      const websiteUrl = process.env.WEBSITE_URL;
      const response = await axios.post(
        `${websiteUrl}/api/staff/infractions`,
        {
          targetDiscordId: targetUserId,
          staffDiscordId: interaction.user.id,
          type: 'SPAMMER_BAN',
          ruleId: 'SPAM',
          reason,
          platforms: ['DISCORD'],
          durationMinutes: null,
          evidenceUrls,
          discordMessageId,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        },
      );

      if (response.data.ok) {
        await interaction.editReply({
          content: `Successfully issued Spammer Ban for <@${targetUserId}>.`,
        });
      } else {
        await interaction.editReply({
          content: `Failed to issue spammer ban: ${response.data.error}`,
        });
      }
    } catch (error: any) {
      console.error('Spammer Ban Command Error:', error);
      await interaction.editReply({
        content: `An error occurred: ${error.message}`,
      });
    }
  }
}
