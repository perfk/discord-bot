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

class TimeoutSlashCommandParams {
  @Param({ description: 'User to timeout', required: true, type: ParamType.USER })
  user: string;

  @Param({
    description: 'Staff remarks / reason for the timeout',
    required: true,
    type: ParamType.STRING,
  })
  staff_remarks: string;

  @Param({
    description: 'Timeout duration in minutes (e.g. 5, 10, 60, 1440. Default is 5)',
    required: false,
    type: ParamType.INTEGER,
  })
  duration?: number;

  @Param({
    description: 'Private remarks (visible to staff only)',
    required: false,
    type: ParamType.STRING,
  })
  private_reason?: string;

  @Param({
    description: 'Discord message link or ID to associate with this timeout as evidence',
    required: false,
    type: ParamType.STRING,
  })
  message_link?: string;
}

@Command({
  name: 'timeout',
  description: 'Issues a timeout to a user on Discord (5 min default)',
})
export class TimeoutCommand {
  @Handler()
  async onTimeout(
    @InteractionEvent(SlashCommandPipe) options: TimeoutSlashCommandParams,
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
      const reason = options.staff_remarks;
      const privateReason = options.private_reason || '';
      const durationMinutes = options.duration ?? 5;

      const evidenceUrls: string[] = [];

      let discordMessageId = null;
      if (options.message_link) {
        let channelId = null;
        let messageId = null;
        const match = options.message_link.match(/channels\/\d+\/(\d+)\/(\d+)/);
        if (match) {
          channelId = match[1];
          messageId = match[2];
        } else {
          messageId = options.message_link.trim();
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
          type: 'TIMEOUT',
          ruleId: 'TIMEOUT',
          reason,
          privateReason,
          durationMinutes,
          platforms: ['DISCORD'],
          evidenceUrls,
          discordMessageId,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        },
      );

      if (response.data.ok) {
        await interaction.editReply({
          content: `Successfully timed out <@${targetUserId}> for ${durationMinutes} minutes.`,
        });
      } else {
        await interaction.editReply({
          content: `Failed to issue timeout: ${response.data.error}`,
        });
      }
    } catch (error: any) {
      console.error('Timeout Command Error:', error);
      await interaction.editReply({
        content: `An error occurred: ${error.message}`,
      });
    }
  }
}
