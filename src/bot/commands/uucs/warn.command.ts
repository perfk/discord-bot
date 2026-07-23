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
import { InjectDb } from 'nest-mongodb';
import * as mongo from 'mongodb';
import axios from 'axios';

class WarnSlashCommandParams {
  @Param({ description: 'User to warn', required: true, type: ParamType.USER })
  user: string;

  @Param({
    description: 'Rule to select (start typing to search)',
    required: true,
    type: ParamType.STRING,
    autocomplete: true,
  })
  rule: string;

  @Param({
    description: 'Staff remarks / reason for the warning',
    required: false,
    type: ParamType.STRING,
  })
  staff_remarks?: string;

  @Param({
    description: 'Timeout duration in hours (e.g. 24)',
    required: false,
    type: ParamType.INTEGER,
  })
  timeout?: number;

  @Param({
    description: 'Discord message link or ID to associate with this warning as evidence',
    required: false,
    type: ParamType.STRING,
  })
  message_link?: string;

  @Param({
    description: 'Evidence File Upload (Drag & Drop here)',
    required: false,
    type: ParamType.ATTACHMENT,
  })
  evidence_file?: any;

  @Param({
    description: 'Evidence Image URL (pasted link)',
    required: false,
    type: ParamType.STRING,
  })
  evidence_url?: string;
}

@Command({
  name: 'warn',
  description: 'Issues a warning to a user in the UUCS system',
})
export class WarnCommand {
  constructor(@InjectDb() private readonly db: mongo.Db) {}

  @Handler()
  async onWarn(
    @InteractionEvent(SlashCommandPipe) options: WarnSlashCommandParams,
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

    // Permission check: Admin, Reforger GM, or Discord Moderator roles
    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
    const isStaff =
      member.roles.cache.has(adminRoleId) ||
      member.roles.cache.has(gmRoleId) ||
      member.roles.cache.some((r) =>
        r.name.toLowerCase().includes('moderator'),
      );

    if (!isStaff) {
      await interaction.reply({
        content: 'You do not have permission to run this command.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const targetUserId = options.user;
      const ruleId = options.rule;
      const reason = options.staff_remarks || null;
      const timeoutHours = options.timeout ?? 0;
      const durationMinutes = timeoutHours * 60;

      const evidenceUrls: string[] = [];
      if (options.evidence_url) {
        evidenceUrls.push(options.evidence_url);
      }
      if (options.evidence_file && options.evidence_file.url) {
        evidenceUrls.push(options.evidence_file.url);
      }

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
          type: 'WARNING',
          ruleId,
          reason,
          durationMinutes,
          platforms: ['ARMA', 'DISCORD'],
          evidenceUrls,
          discordMessageId,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        },
      );

      if (response.data.ok) {
        await interaction.editReply({
          content: `Successfully issued warning for <@${targetUserId}>.`,
        });
      } else {
        await interaction.editReply({
          content: `Failed to issue warning: ${response.data.error}`,
        });
      }
    } catch (error: any) {
      console.error('Warn Command Error:', error);
      await interaction.editReply({
        content: `An error occurred: ${error.message}`,
      });
    }
  }
}
